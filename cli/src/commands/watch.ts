/**
 * `tokenistt watch`: live sessions. On a terminal it redraws one screen in the alternate buffer, so nothing floods the
 * scrollback; anywhere else it prints each new event once, as text or NDJSON, so it can be piped.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { isConnected } from '../agents/connect.js';
import { ADAPTERS, adapterFor } from '../agents/registry.js';
import { listSessions, readPrices, recentEvents, refresh, summarize, type SessionSummary } from '../agents/sessions.js';
import { currentBranch } from '../agents/hook-main.js';
import { openDatabase, type Database } from '../store/db.js';
import { requireProject, type Project } from '../store/project.js';
import { formatCost, formatDuration, formatTokens } from './sessions.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l';
const LEAVE_SCREEN = '\x1b[?25h\x1b[?1049l';
const HOME_CLEAR = '\x1b[H\x1b[J';

export interface WatchFrameInput {
  project: string;
  branch?: string;
  agents: Array<{ name: string; status: 'active' | 'idle' | 'connected' | 'not connected' }>;
  sessions: Array<{ summary: SessionSummary; events: ReturnType<typeof recentEvents> }>;
  width: number;
  height: number;
}

const MARK: Record<string, string> = { FILE_READ: '·', FILE_CREATED: '+', FILE_MODIFIED: '~', FILE_DELETED: '-', ERROR_OCCURRED: '!', TEST_EXECUTED: 'T', COMMAND_EXECUTED: '$', TOOL_INVOKED: '*', TASK_STARTED: '>', TASK_COMPLETED: '✓', SESSION_STARTED: '>', SESSION_RESUMED: '>', SESSION_ENDED: '■' };

export function eventLine(e: { type: string; at: string; tool: string | null; path: string | null; command: string | null; ok: number | null }): string {
  const what = e.path ?? e.command ?? e.tool ?? e.type.toLowerCase().replaceAll('_', ' ');
  return `${e.at.slice(11, 19)}  ${MARK[e.type] ?? ' '} ${what}${e.ok === 0 ? '  failed' : ''}`;
}

/** A pure function of the data, so it can be tested without a terminal. Every line is cut to fit. */
export function renderFrame(i: WatchFrameInput): string {
  const lines: string[] = [];
  lines.push(`${i.project}${i.branch ? `  ${i.branch}` : ''}`, '');
  for (const a of i.agents) lines.push(`${a.status === 'active' ? '●' : a.status === 'not connected' ? '○' : '◌'} ${a.name.padEnd(20)} ${a.status}`);
  lines.push('');
  if (i.sessions.length === 0) lines.push('No sessions yet. They appear here once a connected agent starts working in this repository.');
  for (const { summary: s, events } of i.sessions) {
    const c = s.counts;
    lines.push(`${s.agent}  ${s.id.slice(0, 8)}  ${s.state}${s.task ? `  ${s.task}` : ''}`);
    lines.push(`  ${formatDuration(s.durationMs)}  tokens ${formatTokens(s.tokens)}  cost ${formatCost(s.cost)}  changed ${c.filesCreated + c.filesModified + c.filesDeleted}  errors ${c.errors}`);
    for (const e of events) lines.push(`  ${eventLine(e)}`);
    lines.push('');
  }
  lines.push('Ctrl+C to stop');
  const room = Math.max(3, i.height - 1);
  const shown = lines.length > room ? [...lines.slice(0, room - 1), lines[lines.length - 1] ?? ''] : lines;
  return shown.map((l) => (l.length > i.width ? `${l.slice(0, Math.max(1, i.width - 1))}…` : l)).join('\n');
}

function gather(project: Project, db: Database, home: string, agent: string | undefined): Omit<WatchFrameInput, 'width' | 'height'> {
  refresh(project.repo.root, db);
  const prices = readPrices(project.repo.root);
  const now = Date.now();
  const rows = listSessions(db, { agent, limit: 25 });
  const summaries = rows.map((r) => summarize(db, r, now, prices));
  const live = summaries.filter((s) => s.state === 'active' || s.state === 'idle');
  const shown = (live.length ? live : summaries.slice(0, 1)).slice(0, 4);
  const adapters = agent ? [adapterFor(agent)] : ADAPTERS;
  const agents = adapters.map((a) => {
    const mine = summaries.filter((s) => s.agent === a.id);
    const status = mine.some((s) => s.state === 'active') ? 'active' as const
      : mine.some((s) => s.state === 'idle') ? 'idle' as const
      : a.hookTargets(project.repo.root, home).some((t) => isConnected(a, t)) ? 'connected' as const : 'not connected' as const;
    return { name: a.displayName, status };
  });
  const branch = currentBranch(project.repo.root);
  return { project: project.config.name, ...(branch ? { branch } : {}), agents, sessions: shown.map((s) => ({ summary: s, events: recentEvents(db, s.key, 6) })) };
}

export function registerWatch(program: Command, getCtx: GetCtx): void {
  program
    .command('watch')
    .description('Live view of coding agent sessions in this repository')
    .option('--agent <agent>', 'only this agent')
    .option('--project <path>', 'a repository other than the current directory')
    .option('--interval <ms>', 'how often to check for new events', '1000')
    .action(async (o: { agent?: string; project?: string; interval?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const interval = Number(o.interval);
      if (!Number.isFinite(interval) || interval < 100) throw new UsageError(`Invalid --interval "${o.interval}".`, 'Use at least 100 milliseconds.');
      if (o.agent) adapterFor(o.agent);
      const project = requireProject(o.project ? resolve(o.project) : process.cwd());
      const db = openDatabase(project.repo.root);
      const home = ctx.env.TOKENISTT_HOME ?? homedir();
      const live = !!process.stdout.isTTY && !ctx.out.json;

      const stopped = new Promise<void>((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
      const restore = () => { process.stdout.write(LEAVE_SCREEN); };
      if (live) {
        process.stdout.write(ENTER_SCREEN);
        process.once('exit', restore);
      }
      const seen = new Set<string>();
      let first = true;
      const tick = (): void => {
        const data = gather(project, db, home, o.agent);
        if (live) {
          process.stdout.write(`${HOME_CLEAR}${renderFrame({ ...data, width: process.stdout.columns ?? 80, height: process.stdout.rows ?? 24 })}`);
          return;
        }
        for (const { summary: s, events } of data.sessions) {
          for (const e of events) {
            const key = `${s.key}|${e.at}|${e.type}|${e.path ?? e.command ?? e.tool ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // Existing events are context, not news, except for the first look.
            if (ctx.out.json) ctx.out.line(JSON.stringify({ agent: s.agent, session: s.id, ...e }));
            else ctx.out.line(`${s.agent} ${s.id.slice(0, 8)}  ${eventLine(e)}`);
          }
        }
        if (first && data.sessions.length === 0) ctx.out.info('No sessions yet. Waiting for a connected agent to start working in this repository. Press Ctrl+C to stop.');
        first = false;
      };
      try {
        tick();
        const timer = setInterval(() => {
          try {
            tick();
          } catch {
            // The database may be briefly busy with another process; the next tick picks it up.
          }
        }, interval);
        process.stdout.on('resize', () => { if (live) tick(); });
        await stopped;
        clearInterval(timer);
      } finally {
        if (live) {
          process.removeListener('exit', restore);
          restore();
        }
        db.close();
      }
    });
}
