/**
 * `tokenistt setup`: one guided pass from a bare repository to a working install. Every step says what it does and why,
 * can be skipped, and is safe to repeat. Local features need nothing from the network; the gateway step is optional.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { Output } from '../core/output.js';
import { confirm, isInteractive } from '../core/prompt.js';
import { hookCommand, isConnected, planConnect } from '../agents/connect.js';
import { ADAPTERS, adapterFor } from '../agents/registry.js';
import { runDoctor } from '../services/doctor.js';
import { openDatabase } from '../store/db.js';
import { initProject } from '../store/project.js';
import { repoInfo } from '../project/git.js';
import { homeOf, runChange, targetFor } from './agents.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

export interface SetupOptions {
  yes?: boolean;
  agents?: string;
  /** commander turns --no-gateway into gateway: false */
  gateway?: boolean;
  map?: boolean;
}

/** Runs another tokenistt command in the user's own terminal (for steps that ask questions or take a while). */
function runInTerminal(args: string[], cwd: string): Promise<number | null> {
  const child = spawn(process.execPath, [process.argv[1] ?? '', ...args], { cwd, stdio: 'inherit' });
  return new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code));
  });
}

export async function runSetup(ctx: Context, o: SetupOptions): Promise<void> {
  const interactive = isInteractive();
  if (!interactive && !o.yes) {
    throw new UsageError('`tokenistt setup` asks questions and there is no terminal here.', 'Run it in a terminal, or pass --yes to accept the defaults (add --agents claude-code,codex to choose agents).');
  }
  const say = (m = ''): void => ctx.out.info(m);
  const ask = async (q: string, dflt: boolean): Promise<boolean> => (o.yes ? dflt : confirm(q));
  const step = (n: number, title: string, why: string): void => {
    say('');
    say(ctx.out.bold(`${n}/6  ${title}`));
    say(ctx.out.dim(`     ${why}`));
  };

  say(ctx.out.bold('Tokenistt setup'));
  say('Watches your coding agents, maps your code, and (optionally) links your gateway. Nothing leaves this machine unless you turn it on.');

  // 1. Repository
  step(1, 'Git repository', 'Tokenistt keeps its data per repository, in a .tokenistt folder.');
  let repo = repoInfo(process.cwd());
  if (!repo) {
    say('This folder is not a Git repository.');
    if (!(await ask('Run `git init` here?', true))) throw new UsageError('A Git repository is needed.', 'Run `git init`, or move into an existing repository, then run `tokenistt setup` again.');
    const r = spawnSync('git', ['init'], { cwd: process.cwd(), encoding: 'utf8' });
    if (r.status !== 0) throw new UsageError('`git init` failed.', r.stderr?.trim() || 'Is git installed?');
    repo = repoInfo(process.cwd());
    if (!repo) throw new UsageError('Could not read the new repository.');
  }
  ctx.out.success(`${repo.name}${repo.branch ? ` on ${repo.branch}` : ''}`);

  // 2. init
  step(2, 'Project setup', 'Creates .tokenistt/ and the local database. Only config.json is meant to be committed.');
  const { project, created } = initProject(repo);
  openDatabase(repo.root).close();
  ctx.out.success(created ? 'Created .tokenistt/' : 'Already set up; nothing overwritten');

  // 3. Agents
  step(3, 'Coding agents', 'Hooks let Tokenistt see sessions, tools, files and cost. The change is shown first and backed up.');
  const home = homeOf(ctx.env);
  const wanted = o.agents ? o.agents.split(',').map((a) => a.trim()).filter(Boolean) : undefined;
  const candidates = wanted ? wanted.map((id) => adapterFor(id)) : ADAPTERS.filter((a) => a.detectInstallation(ctx.env, home).installed);
  if (candidates.length === 0) {
    say('No supported agent found on this machine (Claude Code, Codex, Antigravity). Install one later, then run `tokenistt agents connect <agent>`.');
  }
  const connected: string[] = [];
  for (const adapter of candidates) {
    const target = targetFor(adapter, project.repo.root, home, false);
    if (isConnected(adapter, target)) {
      ctx.out.success(`${adapter.displayName} already connected`);
      connected.push(adapter.id);
      continue;
    }
    if (!wanted && !(await ask(`Connect ${adapter.displayName}?`, true))) continue;
    // With --yes the change is made without a second question; otherwise runChange shows the diff and asks.
    // In --json mode setup prints one document at the end, so the per-agent report goes to stderr instead.
    const stepCtx: Context = ctx.out.json ? { ...ctx, out: new Output({ color: false, stdout: process.stderr, stderr: process.stderr }) } : ctx;
    const changed = await runChange(stepCtx, adapter, target, planConnect(adapter, target, hookCommand(adapter.id)), 'connect', { yes: o.yes }, project.repo.root);
    if (changed) connected.push(adapter.id);
  }

  // 4. Map
  step(4, 'Code map', 'Indexes your code so search, impact and agent context work. Takes a few seconds to minutes.');
  if (o.map ?? (await ask('Build the code map now?', false))) {
    const code = await runInTerminal(['map'], repo.root);
    if (code !== 0) say('The map did not finish. You can retry any time with `tokenistt map`.');
  } else {
    say('Skipped. Run `tokenistt map` whenever you like.');
  }

  // 5. Gateway
  step(5, 'Gateway (optional)', 'A Tokenistt gateway adds org-wide cost, budgets and policies. Everything above works without one.');
  if (o.gateway === false || o.yes || !interactive) {
    say('Skipped (local-only). Link one later with `tokenistt login`.');
  } else if (await confirm('Do you have a Tokenistt gateway to link?')) {
    say('You will be asked for its URL and a credential: a dashboard token (from the dashboard), an admin secret (operator), or a virtual API key.');
    const code = await runInTerminal(['login'], repo.root);
    if (code !== 0) say('Login did not complete. Try again with `tokenistt login`.');
  } else {
    say('Skipped (local-only). Link one later with `tokenistt login`.');
  }

  // 6. Doctor
  step(6, 'Check', 'A final look that everything is wired up.');
  const report = await runDoctor({ cfg: ctx.config, client: ctx.makeClient(), nodeVersion: process.version, env: ctx.env, cwd: process.cwd() });
  const mark = { ok: '✔', warn: '!', fail: '✖', skip: '–' } as const;
  for (const c of report.checks) {
    say(`${mark[c.status]} ${c.title}  ${c.detail}`);
    if (c.fix && c.status !== 'ok') say(ctx.out.dim(`    → ${c.fix}`));
  }

  ctx.out.result({ ok: report.ok, repo: repo.root, created, agents: connected, doctor: report.summary }, () => {
    say('');
    say(ctx.out.bold('All set. Next:'));
    say(connected.length ? '  tokenistt watch                follow your agent sessions live' : '  tokenistt agents connect claude-code   track your coding agent');
    say('  tokenistt                      open the dashboard');
    say('  tokenistt --help               everything else');
  });
  if (!report.ok) process.exitCode = 1;
}

export function registerSetup(program: Command, getCtx: GetCtx): void {
  program
    .command('setup')
    .description('Guided first-time setup: project, agents, code map, optional gateway, then a check')
    .option('--yes', 'accept the defaults without asking (agents found on this machine are connected)')
    .option('--agents <list>', 'comma-separated agents to connect, e.g. claude-code,codex')
    .option('--map', 'also build the code map')
    .option('--no-gateway', 'skip the gateway question')
    .addHelpText('after', '\nExamples:\n  tokenistt setup\n  tokenistt setup --yes --agents claude-code --no-gateway')
    .action(async (o: SetupOptions, cmd: Command) => {
      await runSetup(getCtx(cmd), o);
    });
}
