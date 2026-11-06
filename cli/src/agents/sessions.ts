/**
 * Read side of agent observability: usage from transcripts, session summaries, comparison. Every number here comes
 * from recorded events or transcript usage; anything that was not reported stays null and renders as unknown.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
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
  /** What the priced part comes to, even when other parts are unpriced. Not a total: see `unpricedTokens`. */
  knownUsd?: number;
  /** Tokens that no price covered. Zero means `costUsd` is complete. */
  unpricedTokens?: number;
  unpricedModels?: string[];
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

/** Models are priced by the id the vendor reports. Dates and provider prefixes are stripped only to find an id the table already has. */
export function modelIdCandidates(model: string): string[] {
  const out: string[] = [];
  const add = (m: string): void => { if (m && !out.includes(m)) out.push(m); };
  let m = model.trim();
  add(m);
  m = m.toLowerCase();
  add(m);
  const noProvider = m.replace(/^[a-z0-9_-]+[/:]/, '');
  add(noProvider);
  for (const x of [m, noProvider]) {
    add(x.replace(/-(?:latest|\d{8}|\d{4}-\d{2}-\d{2})$/, ''));
    add(x.replace(/@\d{8}$/, ''));
  }
  return out;
}

export function findPrice(prices: PriceTable, model: string): Price | undefined {
  for (const id of modelIdCandidates(model)) {
    const p = prices[id];
    if (p) return p;
  }
  return undefined;
}

function readPriceFile(file: string): PriceTable {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const table = (raw.models && typeof raw.models === 'object' ? raw.models : raw) as Record<string, unknown>;
    const out: PriceTable = {};
    for (const [id, v] of Object.entries(table)) {
      const p = v as Partial<Price> | null;
      if (p && typeof p.input === 'number' && typeof p.output === 'number') {
        out[id] = { input: p.input, output: p.output, ...(typeof p.cachedInput === 'number' ? { cachedInput: p.cachedInput } : {}), ...(typeof p.cacheWrite === 'number' ? { cacheWrite: p.cacheWrite } : {}) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export const pricesCachePath = (root: string): string => join(projectDir(root), 'cache', 'prices.json');
export const pricesOverridePath = (root: string): string => join(projectDir(root), 'prices.json');

/**
 * Prices fetched from your gateway's catalog (cache/prices.json), with your own file (prices.json, USD per 1M tokens)
 * winning where both name a model. There are no built-in prices: with neither file, nothing is priced.
 */
export function readPrices(root: string): PriceTable | undefined {
  const cached = readPriceFile(pricesCachePath(root));
  const mine = readPriceFile(pricesOverridePath(root));
  const merged = { ...cached, ...mine };
  return Object.keys(merged).length ? merged : undefined;
}

/**
 * Prices each usage record by its own model. A cost is a real total only if every token was priced. Otherwise
 * `costUsd` is null (a partial sum would pass for the whole), and the priced part and what was left out are reported
 * separately so neither is hidden.
 */
export function priceUsage(usage: Array<Pick<UsageRow, 'model' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'>>, prices: PriceTable | undefined): CostResult {
  if (usage.length === 0) return { costUsd: null, source: 'unknown', note: 'no usage reported', knownUsd: 0, unpricedTokens: 0, unpricedModels: [] };
  if (!prices) {
    const tokens = usage.reduce((t, u) => t + u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens, 0);
    return { costUsd: null, source: 'unknown', note: 'no price table; run `tokenistt models --refresh` with a gateway connection, or add prices to .tokenistt/prices.json', knownUsd: 0, unpricedTokens: tokens, unpricedModels: [...new Set(usage.map((u) => u.model ?? 'unknown model'))].sort() };
  }
  let known = 0;
  let unpriced = 0;
  let pricedAny = false;
  const missing = new Set<string>();
  for (const u of usage) {
    const p = u.model ? findPrice(prices, u.model) : undefined;
    const name = u.model ?? 'unknown model';
    if (!p) { unpriced += u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens; missing.add(name); continue; }
    known += (u.input_tokens * p.input + u.output_tokens * p.output) / 1_000_000;
    pricedAny = true;
    if (u.cache_read_tokens > 0) {
      if (p.cachedInput === undefined) { unpriced += u.cache_read_tokens; missing.add(`${name} cache reads`); } else known += (u.cache_read_tokens * p.cachedInput) / 1_000_000;
    }
    if (u.cache_creation_tokens > 0) {
      if (p.cacheWrite === undefined) { unpriced += u.cache_creation_tokens; missing.add(`${name} cache writes`); } else known += (u.cache_creation_tokens * p.cacheWrite) / 1_000_000;
    }
  }
  const unpricedModels = [...missing].sort();
  if (unpriced === 0) return { costUsd: known, source: 'catalog_estimate', knownUsd: known, unpricedTokens: 0, unpricedModels: [] };
  return {
    costUsd: null, source: 'unknown', knownUsd: pricedAny ? known : 0, unpricedTokens: unpriced, unpricedModels,
    note: `no price for ${unpricedModels.join(', ')}. Add one in .tokenistt/prices.json or your gateway catalog`,
  };
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

/** One model as the gateway's catalog reports it (`GET /v1/admin/models`). A null price means the gateway has none. */
export interface CatalogModel {
  model: string;
  input_per_1m: number | null;
  output_per_1m: number | null;
  cached_input_per_1m?: number | null;
  cache_write_per_1m?: number | null;
}

/** Only models the catalog really prices. Nothing is filled in for the rest. */
export function priceTableFromCatalog(rows: CatalogModel[]): PriceTable {
  const table: PriceTable = {};
  for (const m of rows) {
    if (m.input_per_1m === null || m.output_per_1m === null) continue;
    table[m.model] = {
      input: m.input_per_1m, output: m.output_per_1m,
      ...(m.cached_input_per_1m != null ? { cachedInput: m.cached_input_per_1m } : {}),
      ...(m.cache_write_per_1m != null ? { cacheWrite: m.cache_write_per_1m } : {}),
    };
  }
  return table;
}

export function writePricesCache(root: string, table: PriceTable): void {
  mkdirSync(join(projectDir(root), 'cache'), { recursive: true });
  writeFileSync(pricesCachePath(root), `${JSON.stringify(table, null, 2)}\n`);
}

/** How old the saved gateway prices are, or null if there are none. */
export function pricesAgeMs(root: string, now = Date.now()): number | null {
  try {
    return now - statSync(pricesCachePath(root)).mtimeMs;
  } catch {
    return null;
  }
}

/** One cost for several sessions. A real total only if every part is; otherwise the priced part and what is missing. */
export function sumCosts(costs: CostResult[]): CostResult {
  if (costs.length === 0) return { costUsd: null, source: 'unknown', knownUsd: 0, unpricedTokens: 0, unpricedModels: [] };
  let known = 0;
  let unpriced = 0;
  let complete = true;
  const models = new Set<string>();
  for (const c of costs) {
    known += c.knownUsd ?? c.costUsd ?? 0;
    unpriced += c.unpricedTokens ?? 0;
    if (c.costUsd === null) complete = false;
    for (const m of c.unpricedModels ?? []) models.add(m);
  }
  return complete
    ? { costUsd: known, source: 'catalog_estimate', knownUsd: known, unpricedTokens: 0, unpricedModels: [] }
    : { costUsd: null, source: 'unknown', knownUsd: known, unpricedTokens: unpriced, unpricedModels: [...models].sort() };
}

/** The one way a cost is written, so every screen and command says the same thing about what is and is not known. */
export function describeCost(c: CostResult): string {
  if (c.costUsd !== null) return `~$${c.costUsd.toFixed(4)} estimated`;
  const known = c.knownUsd ?? 0;
  const left = c.unpricedTokens ?? 0;
  if (known > 0 && left > 0) return `~$${known.toFixed(4)} known + ${left.toLocaleString('en-US')} tokens unpriced`;
  return 'unknown';
}
