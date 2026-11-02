import type { Command } from 'commander';
import { Output } from '../core/output.js';
import { UsageError } from '../core/errors.js';
import { compareSessions, findSession, listSessions, readPrices, recentEvents, refresh, summarize, type CostResult, type SessionSummary, type Tokens } from '../agents/sessions.js';
import { openDatabase } from '../store/db.js';
import { requireProject } from '../store/project.js';
import { formatDuration } from '../tui/format.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

export { formatDuration };

/** Null means the agent did not report it, which must not read as zero. */
export const formatTokens = (t: Tokens | null): string => (t ? t.total.toLocaleString('en-US') : 'unknown');

export function formatCost(c: CostResult): string {
  return c.costUsd === null ? 'unknown' : `~$${c.costUsd.toFixed(4)} estimated`;
}

function list(ctx: Context, rows: SessionSummary[]): void {
  ctx.out.table(rows.map((s) => ({ id: s.id.slice(0, 8), agent: s.agent, state: s.state, branch: s.branch ?? '–', duration: formatDuration(s.durationMs), tokens: formatTokens(s.tokens), cost: formatCost(s.cost), files: s.counts.filesCreated + s.counts.filesModified + s.counts.filesDeleted, started: s.startedAt.slice(0, 16).replace('T', ' ') })), [
    { key: 'id' }, { key: 'agent' }, { key: 'state' }, { key: 'branch' }, { key: 'started' }, { key: 'duration', align: 'right' }, { key: 'tokens', align: 'right' }, { key: 'cost' }, { key: 'files', header: 'changed', align: 'right' },
  ]);
}

function inspect(out: Output, s: SessionSummary, events: ReturnType<typeof recentEvents>): void {
  out.line(`${out.bold(s.agent)}  ${s.id}`);
  out.line(`State:    ${s.state}${s.endReason ? ` (${s.endReason})` : ''}`);
  out.line(`Branch:   ${s.branch ?? 'unknown'}`);
  out.line(`Started:  ${s.startedAt}`);
  out.line(`Duration: ${formatDuration(s.durationMs)}`);
  if (s.task) out.line(`Task:     ${s.task}`);
  out.line(`Model:    ${s.models.join(', ') || 'unknown'}`);
  out.line();
  if (s.tokens) out.line(`Tokens:   ${formatTokens(s.tokens)} over ${s.tokens.requests} requests (input ${s.tokens.input}, output ${s.tokens.output}, cache read ${s.tokens.cacheRead}, cache write ${s.tokens.cacheCreation})`);
  else out.line(`Tokens:   unknown; ${s.agent} does not report them`);
  out.line(`Cost:     ${formatCost(s.cost)}${s.cost.note ? ` (${s.cost.note})` : ''}`);
  if (s.cost.costUsd !== null) out.line(out.dim('          Tokens times catalog prices. Not your bill, and on a subscription not spend at all.'));
  out.line();
  const c = s.counts;
  out.line(`Files:    ${c.filesCreated} created, ${c.filesModified} modified, ${c.filesDeleted} deleted, ${c.filesRead} read`);
  out.line(`Activity: ${c.tasks} tasks, ${c.commands} commands, ${c.tools} other tools, ${c.errors} errors`);
  if (c.testsPassed + c.testsFailed + c.testsUnknown > 0) out.line(`Tests:    ${c.testsPassed} passed, ${c.testsFailed} failed${c.testsUnknown ? `, ${c.testsUnknown} result unknown` : ''}`);
  const changed = [...s.files.created.map((f) => `+ ${f}`), ...s.files.modified.map((f) => `~ ${f}`), ...s.files.deleted.map((f) => `- ${f}`)];
  if (changed.length) {
    out.line();
    out.line(out.bold('Changed files'));
    for (const l of changed) out.line(`  ${l}`);
  }
  if (s.commands.length) {
    out.line();
    out.line(out.bold('Commands'));
    for (const cmd of s.commands.slice(0, 15)) out.line(`  ${String(cmd.count).padStart(3)}  ${cmd.command}`);
  }
  if (events.length) {
    out.line();
    out.line(out.bold('Latest activity'));
    for (const e of events) out.line(`  ${e.at.slice(11, 19)}  ${e.type}${e.path ? `  ${e.path}` : e.command ? `  ${e.command}` : e.tool ? `  ${e.tool}` : ''}${e.ok === 0 ? '  failed' : ''}`);
  }
}

export function registerSessions(program: Command, getCtx: GetCtx): void {
  const sessions = program.command('sessions').description('Coding agent sessions recorded in this repository')
    // Declared once here: the parent parses these wherever they appear, so a copy on a subcommand would never see them.
    .option('--agent <agent>', 'only this agent')
    .option('--limit <n>', 'how many to show (default 10, or 50 for history)');

  const show = (ctx: Context, o: { agent?: string; limit?: string }, fallbackLimit: number, title?: string): void => {
    const project = requireProject(process.cwd());
    const db = openDatabase(project.repo.root);
    try {
      refresh(project.repo.root, db);
      const limit = Number(o.limit ?? fallbackLimit);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`Invalid --limit "${o.limit}".`);
      const prices = readPrices(project.repo.root);
      const now = Date.now();
      const rows = listSessions(db, { agent: o.agent, limit }).map((r) => summarize(db, r, now, prices));
      ctx.out.result({ sessions: rows }, () => {
        if (rows.length === 0) {
          ctx.out.line('No sessions recorded yet.');
          ctx.out.info('Connect an agent with `tokenistt agents connect <agent>`, then use it in this repository.');
          return;
        }
        if (title) ctx.out.line(ctx.out.bold(title));
        list(ctx, rows);
      });
    } finally {
      db.close();
    }
  };

  sessions.action((o: { agent?: string; limit?: string }, cmd: Command) => show(getCtx(cmd), o, 10));

  sessions.command('history').description('All recorded sessions, most recent first')
    .action((_o: unknown, cmd: Command) => show(getCtx(cmd), cmd.optsWithGlobals() as { agent?: string; limit?: string }, 50));

  sessions.command('inspect <id>').description('Everything recorded about one session. A unique start of the id is enough')
    .action((id: string, _o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const project = requireProject(process.cwd());
      const db = openDatabase(project.repo.root);
      try {
        refresh(project.repo.root, db);
        const row = findSession(db, id);
        const s = summarize(db, row, Date.now(), readPrices(project.repo.root));
        const events = recentEvents(db, row.key);
        ctx.out.result({ ...s, recentEvents: events }, () => inspect(ctx.out, s, events));
      } finally {
        db.close();
      }
    });

  sessions.command('compare <id1> <id2>').description('Two sessions side by side, and which files they both changed')
    .action((id1: string, id2: string, _o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const project = requireProject(process.cwd());
      const db = openDatabase(project.repo.root);
      try {
        refresh(project.repo.root, db);
        const prices = readPrices(project.repo.root);
        const now = Date.now();
        const cmp = compareSessions(summarize(db, findSession(db, id1), now, prices), summarize(db, findSession(db, id2), now, prices));
        ctx.out.result(cmp, () => {
          const col = (s: SessionSummary) => ({
            agent: s.agent, state: s.state, branch: s.branch ?? '–', duration: formatDuration(s.durationMs), tokens: formatTokens(s.tokens), cost: formatCost(s.cost),
            model: s.models.join(', ') || 'unknown', tasks: String(s.counts.tasks), changed: String(s.counts.filesCreated + s.counts.filesModified + s.counts.filesDeleted), commands: String(s.counts.commands), errors: String(s.counts.errors),
          });
          const [a, b] = [col(cmp.a), col(cmp.b)];
          const rows = (Object.keys(a) as Array<keyof typeof a>).map((k) => ({ what: k, a: a[k], b: b[k] }));
          ctx.out.table(rows, [{ key: 'what', header: '' }, { key: 'a', header: cmp.a.id.slice(0, 8) }, { key: 'b', header: cmp.b.id.slice(0, 8) }]);
          ctx.out.line();
          ctx.out.line(`Changed by both: ${cmp.sharedFiles.length ? cmp.sharedFiles.join(', ') : 'none'}`);
          ctx.out.line(`Only ${cmp.a.id.slice(0, 8)}: ${cmp.onlyA.length}. Only ${cmp.b.id.slice(0, 8)}: ${cmp.onlyB.length}.`);
        });
      } finally {
        db.close();
      }
    });
}
