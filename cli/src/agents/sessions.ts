/**
 * Read side of agent observability: usage from transcripts, session summaries, comparison. Every number here comes
 * from recorded events or transcript usage; anything that was not reported stays null and renders as unknown.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../core/errors.js';
import type { Database } from '../store/db.js';
import { projectDir } from '../store/project.js';
import { adapterFor } from './registry.js';
import { ingestEvents } from './session-manager.js';
import type { UsageRecord } from './adapter.js';

/** With no end event, or a crash, a session that has gone quiet this long is treated as over. */
export const IDLE_AFTER_MS = 5 * 60_000;
export const INACTIVE_AFTER_MS = 30 * 60_000;

export type SessionState = 'active' | 'idle' | 'inactive' | 'ended';

export interface Price {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
}
export type PriceTable = Record<string, Price>;

export interface CostResult {
  costUsd: number | null;
  /** catalog_estimate: tokens times catalog prices. It is not what you were billed, and on a subscription it is not spend at all. */
  source: 'catalog_estimate' | 'unknown';
  /** Why it is unknown, or which models were missing. */
  note?: string;
}

export interface SessionRow {
  key: string;
  agent: string;
  session_id: string;
  branch: string | null;
  started_at: string;
  ended_at: string | null;
  last_event_at: string;
  status: string;
  end_reason: string | null;
  model: string | null;
  task: string | null;
  transcript: string | null;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  requests: number;
}

export interface SessionSummary {
  key: string;
  agent: string;
  id: string;
  branch: string | null;
  state: SessionState;
  startedAt: string;
  endedAt: string | null;
  lastEventAt: string;
  durationMs: number;
  endReason: string | null;
  task: string | null;
  models: string[];
  /** Null when this agent does not report usage, which is different from zero. */
  tokens: Tokens | null;
  cost: CostResult;
  counts: { tasks: number; filesRead: number; filesCreated: number; filesModified: number; filesDeleted: number; commands: number; tools: number; errors: number; testsPassed: number; testsFailed: number; testsUnknown: number };
  files: { read: string[]; created: string[]; modified: string[]; deleted: string[] };
  commands: Array<{ command: string; count: number }>;
}

export function sessionState(row: Pick<SessionRow, 'status' | 'last_event_at'>, now: number): SessionState {
  if (row.status === 'ended') return 'ended';
  const quiet = now - Date.parse(row.last_event_at);
  if (quiet > INACTIVE_AFTER_MS) return 'inactive';
  return quiet > IDLE_AFTER_MS ? 'idle' : 'active';
}

function readTail(file: string, offset: number): { text: string; size: number } | undefined {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { text: '', size };
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    // Only whole lines: a line still being written is read next time.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { text: '', size: offset };
    return { text: buf.subarray(0, end).toString('utf8'), size: offset + end + 1 };
  } finally {
    closeSync(fd);
  }
}

/** Reads new transcript lines for sessions whose agent can report usage. One API call is stored once, however often it is read. */
export function ingestUsage(db: Database): number {
  const rows = db.prepare('SELECT key, agent, transcript FROM agent_sessions WHERE transcript IS NOT NULL').all() as unknown as Array<Pick<SessionRow, 'key' | 'agent' | 'transcript'>>;
  const getOffset = db.prepare('SELECT offset FROM agent_ingest WHERE file = ?');
  const setOffset = db.prepare('INSERT INTO agent_ingest (file, offset) VALUES (?, ?) ON CONFLICT (file) DO UPDATE SET offset = excluded.offset');
  const upsert = db.prepare(`INSERT INTO agent_usage (session_key, request_id, model, at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_key, request_id) DO UPDATE SET model = excluded.model, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens, cache_creation_tokens = excluded.cache_creation_tokens`);
  let added = 0;
  for (const r of rows) {
    let collect: ((text: string) => UsageRecord[]) | undefined;
    try {
      collect = adapterFor(r.agent).collectUsage;
    } catch {
      continue;
    }
    const file = r.transcript ?? '';
    // Event files are plain text in the repository, so a path from one is only followed to a transcript-shaped file.
    if (!collect || !file.endsWith('.jsonl') || !existsSync(file)) continue;
    const key = `transcript:${r.key}`;
    const offset = (getOffset.get(key) as { offset: number } | undefined)?.offset ?? 0;
    const tail = readTail(file, offset);
    if (!tail?.text) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const u of collect(tail.text)) {
        const res = upsert.run(r.key, u.requestId, u.model ?? null, u.at ?? null, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheCreationTokens);
        added += Number(res.changes);
      }
      setOffset.run(key, tail.size);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return added;
}

export function refresh(root: string, db: Database): void {
  ingestEvents(root, db);
  ingestUsage(db);
}

/** Prices cached from the gateway's catalog, if any. There are no built-in prices, so offline with no cache means unknown. */
export function readPrices(root: string): PriceTable | undefined {
  const file = join(projectDir(root), 'cache', 'prices.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PriceTable;
  } catch {
    return undefined;
  }
}

/**
 * A partial estimate would look like a real number while leaving out most of the cost: agent sessions are mostly cache
 * reads. So a session is priced only if every token type it used has a price, and is otherwise unknown.
 */
export function priceUsage(usage: Array<Pick<UsageRow, 'model' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'>>, prices: PriceTable | undefined): CostResult {
  if (usage.length === 0) return { costUsd: null, source: 'unknown', note: 'no usage reported' };
  if (!prices) return { costUsd: null, source: 'unknown', note: 'no price catalog; run `tokenistt models --refresh` with a gateway connection' };
  let total = 0;
  const missing = new Set<string>();
  for (const u of usage) {
    const p = u.model ? prices[u.model] : undefined;
    if (!p) { missing.add(u.model ?? 'unknown model'); continue; }
    if ((u.cache_read_tokens > 0 && p.cachedInput === undefined) || (u.cache_creation_tokens > 0 && p.cacheWrite === undefined)) {
      missing.add(`${u.model} cache pricing`);
      continue;
    }
    total += (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_tokens * (p.cachedInput ?? 0) + u.cache_creation_tokens * (p.cacheWrite ?? 0)) / 1_000_000;
  }
  if (missing.size) return { costUsd: null, source: 'unknown', note: `no catalog price for ${[...missing].sort().join(', ')}` };
  return { costUsd: total, source: 'catalog_estimate' };
}

interface UsageRow {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

interface EventRow {
  type: string;
  path: string | null;
  command: string | null;
  ok: number | null;
  model: string | null;
}

export function summarize(db: Database, row: SessionRow, now: number, prices?: PriceTable): SessionSummary {
  const events = db.prepare('SELECT type, path, command, ok, model FROM agent_events WHERE session_key = ?').all(row.key) as unknown as EventRow[];
  const usage = db.prepare('SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM agent_usage WHERE session_key = ?').all(row.key) as unknown as UsageRow[];

  const sets = { read: new Set<string>(), created: new Set<string>(), modified: new Set<string>(), deleted: new Set<string>() };
  const commands = new Map<string, number>();
  const models = new Set<string>();
  const c = { tasks: 0, filesRead: 0, filesCreated: 0, filesModified: 0, filesDeleted: 0, commands: 0, tools: 0, errors: 0, testsPassed: 0, testsFailed: 0, testsUnknown: 0 };
  for (const e of events) {
    if (e.model) models.add(e.model);
    if (e.command) commands.set(e.command, (commands.get(e.command) ?? 0) + 1);
    switch (e.type) {
      case 'TASK_STARTED': c.tasks++; break;
      case 'FILE_READ': if (e.path) sets.read.add(e.path); break;
      case 'FILE_CREATED': if (e.path) sets.created.add(e.path); break;
      case 'FILE_MODIFIED': if (e.path) sets.modified.add(e.path); break;
      case 'FILE_DELETED': if (e.path) sets.deleted.add(e.path); break;
      case 'COMMAND_EXECUTED': c.commands++; break;
      case 'TOOL_INVOKED': c.tools++; break;
      case 'ERROR_OCCURRED': c.errors++; break;
      case 'TEST_EXECUTED':
        c.commands++;
        if (e.ok === 1) c.testsPassed++;
        else if (e.ok === 0) c.testsFailed++;
        else c.testsUnknown++;
        break;
      default: break;
    }
  }
  c.filesRead = sets.read.size;
  c.filesCreated = sets.created.size;
  c.filesModified = sets.modified.size;
  c.filesDeleted = sets.deleted.size;
  for (const u of usage) if (u.model) models.add(u.model);

  // With usage unread (no transcript yet, or an agent that has none), the honest answer is unknown, not zero.
  const canReport = !!adapterForSafe(row.agent)?.collectUsage && !!row.transcript;
  const tokens: Tokens | null = usage.length || canReport
    ? usage.reduce<Tokens>((t, u) => ({
        input: t.input + u.input_tokens, output: t.output + u.output_tokens, cacheRead: t.cacheRead + u.cache_read_tokens, cacheCreation: t.cacheCreation + u.cache_creation_tokens,
        total: t.total + u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens, requests: t.requests + 1,
      }), { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, requests: 0 })
    : null;

  const state = sessionState(row, now);
  const end = row.ended_at ? Date.parse(row.ended_at) : state === 'active' ? now : Date.parse(row.last_event_at);
  return {
    key: row.key, agent: row.agent, id: row.session_id, branch: row.branch, state, startedAt: row.started_at, endedAt: row.ended_at, lastEventAt: row.last_event_at,
    durationMs: Math.max(0, end - Date.parse(row.started_at)), endReason: row.end_reason, task: row.task, models: [...models].sort(), tokens,
    cost: priceUsage(usage, prices), counts: c,
    files: { read: [...sets.read].sort(), created: [...sets.created].sort(), modified: [...sets.modified].sort(), deleted: [...sets.deleted].sort() },
    commands: [...commands].map(([command, count]) => ({ command, count })).sort((a, b) => b.count - a.count || a.command.localeCompare(b.command)),
  };
}

function adapterForSafe(agent: string) {
  try {
    return adapterFor(agent);
  } catch {
    return undefined;
  }
}

export function listSessions(db: Database, opts: { agent?: string; limit?: number } = {}): SessionRow[] {
  const limit = opts.limit ?? 20;
  if (opts.agent) return db.prepare('SELECT * FROM agent_sessions WHERE agent = ? ORDER BY last_event_at DESC LIMIT ?').all(adapterFor(opts.agent).id, limit) as unknown as SessionRow[];
  return db.prepare('SELECT * FROM agent_sessions ORDER BY last_event_at DESC LIMIT ?').all(limit) as unknown as SessionRow[];
}

/** Accepts a unique prefix of the session id, since ids are long. */
export function findSession(db: Database, id: string): SessionRow {
  const rows = db.prepare(`SELECT * FROM agent_sessions WHERE session_id LIKE ? ESCAPE '\\' OR key = ? ORDER BY last_event_at DESC LIMIT 3`).all(`${id.replace(/[\\%_]/g, '\\$&')}%`, id) as unknown as SessionRow[];
  if (rows.length === 0) throw new CliError(`No session matches "${id}".`, 2, 'List them with `tokenistt sessions history`.');
  if (rows.length > 1) throw new CliError(`"${id}" matches more than one session.`, 2, 'Use more of the id.');
  return rows[0] as SessionRow;
}

export function recentEvents(db: Database, key: string, limit = 20): Array<{ type: string; at: string; tool: string | null; path: string | null; command: string | null; ok: number | null }> {
  const rows = db.prepare('SELECT type, at, tool, path, command, ok FROM agent_events WHERE session_key = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(key, limit) as unknown as Array<{ type: string; at: string; tool: string | null; path: string | null; command: string | null; ok: number | null }>;
  return rows.reverse();
}

/** Sessions that touched a file, for the graph viewer. */
export function sessionsForPath(db: Database, path: string, limit = 10): Array<{ key: string; agent: string; id: string; lastEventAt: string; touches: number; changed: boolean }> {
  const rows = db.prepare(`SELECT s.key, s.agent, s.session_id, s.last_event_at, count(*) AS touches,
      max(CASE WHEN e.type IN ('FILE_CREATED', 'FILE_MODIFIED', 'FILE_DELETED') THEN 1 ELSE 0 END) AS changed
    FROM agent_events e JOIN agent_sessions s ON s.key = e.session_key WHERE e.path = ? GROUP BY s.key ORDER BY s.last_event_at DESC LIMIT ?`).all(path, limit) as unknown as Array<{ key: string; agent: string; session_id: string; last_event_at: string; touches: number; changed: number }>;
  return rows.map((r) => ({ key: r.key, agent: r.agent, id: r.session_id, lastEventAt: r.last_event_at, touches: r.touches, changed: r.changed === 1 }));
}

export interface SessionComparison {
  a: SessionSummary;
  b: SessionSummary;
  sharedFiles: string[];
  onlyA: string[];
  onlyB: string[];
}

export function compareSessions(a: SessionSummary, b: SessionSummary): SessionComparison {
  const touched = (s: SessionSummary) => new Set([...s.files.created, ...s.files.modified, ...s.files.deleted]);
  const [ta, tb] = [touched(a), touched(b)];
  return { a, b, sharedFiles: [...ta].filter((f) => tb.has(f)).sort(), onlyA: [...ta].filter((f) => !tb.has(f)).sort(), onlyB: [...tb].filter((f) => !ta.has(f)).sort() };
}
