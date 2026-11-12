/**
 * `tokenistt run <agent>`: start a coding agent in this terminal, with tracking on, and say what happened when it
 * exits. The agent keeps the terminal to itself (inherited stdio, no PTY), so there is nothing to embed and no second
 * window to open. For Claude Code the live numbers appear in its own status bar; for the other agents the summary
 * at the end is the record, and `tokenistt watch` follows them from another pane.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { confirm, isInteractive } from '../core/prompt.js';
import { hookCommand, isConnected, planConnect, statusLineCommand } from '../agents/connect.js';
import { onPath } from '../agents/detect.js';
import { adapterFor } from '../agents/registry.js';
import { describeCost, listSessions, readPrices, refresh, summarize, type SessionSummary } from '../agents/sessions.js';
import { openDatabase } from '../store/db.js';
import { projectDir, readProjectConfig, requireProject } from '../store/project.js';
import { repoInfo } from '../project/git.js';
import { formatDuration } from '../tui/format.js';
import { homeOf, runChange, targetFor } from './agents.js';
import { runSetup } from './setup.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

/** What each agent's program is called on PATH. */
const BINARIES: Record<string, string[]> = { 'claude-code': ['claude'], codex: ['codex'], antigravity: ['antigravity', 'agy'] };

export function resolveAgentBinary(agentId: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const name of BINARIES[agentId] ?? []) {
    const found = onPath(name, env);
    if (found) return found;
  }
  return undefined;
}

const quote = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

/** On Windows, npm installs agents as .cmd shims, which can only be started through a shell. */
export function launchSpec(file: string, args: string[], platform: string = process.platform): { file: string; args: string[]; shell: boolean } {
  if (platform === 'win32' && ['.cmd', '.bat'].includes(extname(file).toLowerCase())) return { file: quote(file), args: args.map(quote), shell: true };
  return { file, args, shell: false };
}

/** Pure, so the wording is tested without running an agent. */
export function summaryLines(sessions: SessionSummary[]): string[] {
  if (sessions.length === 0) return ['No session was recorded. If the agent did start, check `tokenistt doctor` for its hooks.'];
  const lines: string[] = [];
  for (const s of sessions) {
    const c = s.counts;
    const changed = c.filesCreated + c.filesModified + c.filesDeleted;
    lines.push(`${s.agent}  ${s.id.slice(0, 8)}  ${formatDuration(s.durationMs)}`);
    lines.push(`  tokens ${s.tokens ? s.tokens.total.toLocaleString('en-US') : 'unknown'}   cost ${describeCost(s.cost)}`);
    lines.push(`  ${c.tools + c.commands} tools, ${changed} files changed, ${c.filesRead} read, ${c.errors} errors${c.testsPassed + c.testsFailed ? `, tests ${c.testsPassed} passed / ${c.testsFailed} failed` : ''}`);
  }
  lines.push('Details: `tokenistt sessions history`. Cost is an estimate from token counts; on a subscription it is not what you paid.');
  return lines;
}

/** A settings file for this run only, so the user's own Claude Code settings are never edited. */
function claudeRunSettings(root: string): string {
  const dir = join(projectDir(root), 'cache');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'claude-run-settings.json');
  writeFileSync(file, `${JSON.stringify({ statusLine: { type: 'command', command: statusLineCommand() } }, null, 2)}\n`);
  return file;
}

interface RunOptions {
  yes?: boolean;
  status?: boolean;
}

export async function runAgent(ctx: Context, agent: string, passArgs: string[], o: RunOptions): Promise<number> {
  const adapter = adapterFor(agent);
  const bin = resolveAgentBinary(adapter.id, ctx.env);
  if (!bin) throw new UsageError(`${adapter.displayName} was not found on your PATH.`, `Install it first, then run \`tokenistt run ${agent}\` again.`);

  if (!readProjectConfig(repoInfo(process.cwd())?.root ?? process.cwd())) {
    if (isInteractive() && !o.yes && (await confirm('This repository is not set up for Tokenistt yet. Run the guided setup now?'))) {
      await runSetup(ctx, { agents: adapter.id, gateway: false });
    }
  }
  const project = requireProject(process.cwd());
  const root = project.repo.root;
  const home = homeOf(ctx.env);

  if (!adapter.hookTargets(root, home).some((t) => isConnected(adapter, t))) {
    const target = targetFor(adapter, root, home, false);
    const changed = await runChange(ctx, adapter, target, planConnect(adapter, target, hookCommand(adapter.id)), 'connect', { yes: o.yes }, root);
    if (!changed) ctx.out.warn(`Tracking is off for this run: ${adapter.displayName} is not connected.`);
  }

  const args = [...passArgs];
  const live = adapter.id === 'claude-code' && o.status !== false && !args.some((a) => a === '--settings' || a.startsWith('--settings='));
  if (live) args.unshift('--settings', claudeRunSettings(root));

  ctx.out.info(live ? `Starting ${adapter.displayName}. Live cost and activity show in its status bar.` : `Starting ${adapter.displayName}. A summary follows when it exits.`);
  const startedAt = new Date().toISOString();
  const spec = launchSpec(bin, args);
  // Ctrl+C belongs to the agent. We stay alive until it exits so the summary still prints.
  const ignore = (): void => {};
  process.on('SIGINT', ignore);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(spec.file, spec.args, { cwd: process.cwd(), stdio: 'inherit', shell: spec.shell, env: process.env });
    child.on('error', (e) => {
      ctx.out.error(`Could not start ${adapter.displayName}: ${e.message}`);
      resolve(1);
    });
    child.on('close', (c, signal) => resolve(signal ? 1 : (c ?? 1)));
  });
  process.off('SIGINT', ignore);

  const db = openDatabase(root);
  try {
    refresh(root, db);
    const prices = readPrices(root);
    const now = Date.now();
    const sessions = listSessions(db, { agent: adapter.id, limit: 20 })
      .filter((r) => r.last_event_at >= startedAt)
      .map((r) => summarize(db, r, now, prices));
    ctx.out.line('');
    ctx.out.result({ agent: adapter.id, exit_code: code, sessions }, () => {
      for (const l of summaryLines(sessions)) ctx.out.line(l);
    });
  } finally {
    db.close();
  }
  return code;
}

export function registerRun(program: Command, getCtx: GetCtx): void {
  program
    .command('run <agent> [args...]')
    .description('Start a coding agent here (claude-code, codex, antigravity) with tracking on, and get a summary when it exits')
    .option('--yes', 'connect the agent\'s hooks without asking')
    .option('--no-status', 'do not add the live status line to Claude Code')
    .allowUnknownOption()
    .allowExcessArguments()
    .addHelpText('after', '\nPut the agent\'s own options after `--`:\n  tokenistt run claude\n  tokenistt run claude -- --resume\n  tokenistt run codex')
    .action(async (agent: string, args: string[], o: RunOptions, cmd: Command) => {
      process.exitCode = await runAgent(getCtx(cmd), agent, args, o);
    });
}
