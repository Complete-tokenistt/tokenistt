/**
 * Bare `tokenistt`. On a terminal it opens the dashboard after real startup checks; anywhere else it prints a plain
 * status and exits, so scripts and CI never get stuck in an interface.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { unicodeSupported } from '../tui/theme.js';
import { motionAllowed, Progress } from '../core/progress.js';
import { repoInfo } from '../project/git.js';
import { openDatabase } from '../store/db.js';
import { readProjectConfig, projectDir } from '../store/project.js';
import type { Context } from '../context.js';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Runs a real tokenistt command as a child process and hands back its output a line at a time. */
export function runChild(args: string[], cwd: string, env: NodeJS.ProcessEnv, onLine: (line: string) => void): { done: Promise<number | null>; stop: () => void } {
  const entry = process.argv[1] ?? '';
  const child = spawn(process.execPath, [entry, ...args], { cwd, env: { ...env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const feed = (): ((chunk: Buffer) => void) => {
    let rest = '';
    return (chunk) => {
      const parts = (rest + chunk.toString('utf8')).split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const p of parts) onLine(p.replace(ANSI, '').trimEnd());
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

const ENTER ='\x1b[?1049h';
const LEAVE = '\x1b[?1049l\x1b[?25h';

export async function runDashboard(ctx: Context, showHelp: () => void): Promise<void> {
  const repo = repoInfo(process.cwd());
  const config = repo ? readProjectConfig(repo.root) : undefined;
  if (!repo || !config) {
    showHelp();
    ctx.out.info('');
    ctx.out.info(repo ? 'This repository is not set up yet. Run `tokenistt init`.' : 'Run this inside a Git repository to see its dashboard.');
    return;
  }
  const project = { repo, dir: projectDir(repo.root), config };
  const home = ctx.env.TOKENISTT_HOME ?? homedir();
  const { fetchFinops, gatherLocal, plainStatus, probeGateway, searchAll } = await import('../tui/data.js');
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !ctx.out.json;
  const motion = motionAllowed(ctx.env, process.stdout.isTTY);
  const progress = new Progress({ silent: ctx.out.json || ctx.out.quiet || !interactive, motion, color: ctx.out.color });

  const db = openDatabase(repo.root);
  try {
    progress.start('Reading agent sessions and project memory');
    const local = gatherLocal(project, db, home);
    progress.succeed(`${local.sessions.length} sessions, ${local.memory.active} memories`);
    progress.start('Checking gateway');
    const gateway = await probeGateway(ctx.config);
    progress.succeed(gateway.state);
    progress.stop();
    const initialFinops = gateway.state === 'connected' ? await fetchFinops(ctx.config) : undefined;
    const data = { ...local, gateway, ...(initialFinops ? { finops: initialFinops } : {}) };

    if (!interactive) {
      ctx.out.result(data, () => ctx.out.line(plainStatus(data)));
      return;
    }

    const [{ render }, { createElement }, { App }] = await Promise.all([import('ink'), import('react'), import('../tui/App.js')]);
    const restore = (): void => { process.stdout.write(LEAVE); };
    process.stdout.write(ENTER);
    process.once('exit', restore);
    let last = gateway;
    let ticks = 0;
    const reload = async () => {
      // The gateway is checked less often than local data, since it is a network call.
      if (++ticks % 15 === 0) last = await probeGateway(ctx.config);
      return { ...gatherLocal(project, db, home), gateway: last };
    };
    const app = render(createElement(App, { data, motion, reload, search: (q: string) => searchAll(db, q), exec: (args: string[], onLine: (l: string) => void) => runChild(args, repo.root, ctx.env, onLine), unicode: unicodeSupported(ctx.env) }), { exitOnCtrlC: true, incrementalRendering: true, maxFps: 20 });
    try {
      await app.waitUntilExit();
    } finally {
      process.removeListener('exit', restore);
      restore();
    }
  } finally {
    progress.stop();
    db.close();
  }
}
