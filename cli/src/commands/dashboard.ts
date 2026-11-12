/**
 * Bare `tokenistt`. On a terminal it opens the dashboard after real startup checks; anywhere else it prints a plain
 * status and exits, so scripts and CI never get stuck in an interface.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { cleanLine } from '../tui/format.js';
import { MOUSE_OFF, MOUSE_ON } from '../tui/mouse.js';
import { unicodeSupported } from '../tui/theme.js';
import { confirm } from '../core/prompt.js';
import { motionAllowed, Progress } from '../core/progress.js';
import { repoInfo } from '../project/git.js';
import { openDatabase } from '../store/db.js';
import { readProjectConfig, projectDir } from '../store/project.js';
import type { Context } from '../context.js';

/** Runs a real tokenistt command as a child process and hands back its output a line at a time. */
export function runChild(args: string[], cwd: string, env: NodeJS.ProcessEnv, onLine: (line: string) => void): { done: Promise<number | null>; stop: () => void } {
  const entry = process.argv[1] ?? '';
  const child = spawn(process.execPath, [entry, ...args], { cwd, env: { ...env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const feed = (): ((chunk: Buffer) => void) => {
    let rest = '';
    return (chunk) => {
      // A spinner rewrites its own line with a carriage return, so lines end at \n only and cleanLine keeps what was written last.
      const parts = (rest + chunk.toString('utf8')).split('\n');
      rest = parts.pop() ?? '';
      for (const p of parts) {
        const line = cleanLine(p);
        if (line) onLine(line);
      }
    };
  };
  const out = feed();
  const err = feed();
  child.stdout.on('data', out);
  child.stderr.on('data', err);
  const done = new Promise<number | null>((resolve) => {
    child.on('error', (e) => { onLine(`Could not start: ${e.message}`); resolve(1); });
    child.on('close', (code, signal) => resolve(signal ? null : code));
  });
  return { done, stop: () => { child.kill(); } };
}

const ENTER = '\x1b[?1049h\x1b[2J\x1b[H';
const LEAVE = '\x1b[?1049l\x1b[?25h';

export async function runDashboard(ctx: Context, showHelp: () => void): Promise<void> {
  const repo = repoInfo(process.cwd());
  const config = repo ? readProjectConfig(repo.root) : undefined;
  if (!repo || !config) {
    // A person at a terminal who has not set anything up gets the guided setup instead of a wall of help.
    if (process.stdin.isTTY && process.stderr.isTTY && !ctx.out.json && !ctx.out.quiet) {
      ctx.out.info(repo ? 'This repository is not set up yet.' : 'Welcome to Tokenistt.');
      if (await confirm('Run the guided setup now?')) {
        const { runSetup } = await import('./setup.js');
        await runSetup(ctx, {});
        return;
      }
    }
    showHelp();
    ctx.out.info('');
    ctx.out.info(repo ? 'This repository is not set up yet. Run `tokenistt init`.' : 'Run this inside a Git repository to see its dashboard.');
    return;
  }
  const project = { repo, dir: projectDir(repo.root), config };
  const home = ctx.env.TOKENISTT_HOME ?? homedir();
  const { fetchFinops, gatherLocal, plainStatus, probeGateway, refreshPricesIfStale, searchAll } = await import('../tui/data.js');
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !ctx.out.json;
  const motion = motionAllowed(ctx.env, process.stdout.isTTY);
  const progress = new Progress({ silent: ctx.out.json || ctx.out.quiet || !interactive, motion, color: ctx.out.color });

  const db = openDatabase(repo.root);
  try {
    progress.start('Checking gateway');
    const gateway = await probeGateway(ctx.config);
    progress.succeed(gateway.state);
    // Session costs need the gateway's prices; fetch them when there are none yet or they are a day old.
    if (gateway.state === 'connected') await refreshPricesIfStale(ctx.config, repo.root);
    progress.start('Reading agent sessions and project memory');
    const local = gatherLocal(project, db, home);
    progress.succeed(`${local.sessions.length} sessions, ${local.memory.active} memories`);
    progress.stop();
    const initialFinops = gateway.state === 'connected' ? await fetchFinops(ctx.config) : undefined;
    const data = { ...local, gateway, ...(initialFinops ? { finops: initialFinops } : {}) };

    if (!interactive) {
      ctx.out.result(data, () => ctx.out.line(plainStatus(data)));
      return;
    }

    const [{ render }, { createElement }, { App }] = await Promise.all([import('ink'), import('react'), import('../tui/App.js')]);
    const mouse = ctx.env.TOKENISTT_NO_MOUSE !== '1';
    let restored = false;
    // Whatever way this ends, the terminal must be given back: main screen, cursor, and no mouse reporting left on.
    const restore = (): void => {
      if (restored) return;
      restored = true;
      process.stdout.write(`${mouse ? MOUSE_OFF : ''}${LEAVE}`);
    };
    const onSignal = (): void => { restore(); process.exit(130); };
    process.stdout.write(`${ENTER}${mouse ? MOUSE_ON : ''}`);
    process.once('exit', restore);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    let last = gateway;
    let finops = initialFinops;
    let ticks = 0;
    const reload = async () => {
      // The gateway is checked less often than local data, since it is a network call.
      if (++ticks % 15 === 0) {
        last = await probeGateway(ctx.config);
        if (last.state === 'connected') {
          await refreshPricesIfStale(ctx.config, repo.root);
          finops = await fetchFinops(ctx.config);
        } else finops = undefined;
      }
      return { ...gatherLocal(project, db, home), gateway: last, ...(finops ? { finops } : {}) };
    };
    // The frame is the size of the terminal and Ink redraws it whole each time, so nothing old can be left on screen.
    const app = render(createElement(App, { data, motion, reload, search: (q: string) => searchAll(db, q), exec: (args: string[], onLine: (l: string) => void) => runChild(args, repo.root, ctx.env, onLine), unicode: unicodeSupported(ctx.env) }), { exitOnCtrlC: true, maxFps: 20 });
    try {
      await app.waitUntilExit();
    } finally {
      process.removeListener('exit', restore);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      restore();
    }
  } finally {
    progress.stop();
    db.close();
  }
}
