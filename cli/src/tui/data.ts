/** What the dashboard shows, gathered from real sources. A value with no source is null and renders as unknown. */
import { ApiClient } from '../api/client.js';
import { isConnected } from '../agents/connect.js';
import { ADAPTERS } from '../agents/registry.js';
import { listSessions, priceTableFromCatalog, priceUsage, pricesAgeMs, readPrices, refresh, sumCosts, summarize, writePricesCache, type CatalogModel, type CostResult, type PriceTable, type SessionSummary } from '../agents/sessions.js';
import type { ResolvedConfig } from '../config/store.js';
import { readMetadata, type GraphMetadata } from '../graph/store.js';
import { GraphIndex } from '../graph/query.js';
import { memoryStats, listMemories, searchMemories, type Memory, type MemoryStats } from '../memory/store.js';
import type { Database } from '../store/db.js';
import type { Project } from '../store/project.js';

export interface AgentRow {
  id: string;
  name: string;
  installed: boolean;
  connected: boolean;
  state: 'active' | 'idle' | 'connected' | 'not connected';
  verification: string;
}

export interface CostRow {
  agent: string;
  sessions: number;
  /** Tokens from the sessions that reported them. A session that did not is counted in `unreportedSessions`, not as zero. */
  tokens: number;
  unreportedSessions: number;
  cost: CostResult;
}

export interface GatewayStatus {
  state: 'connected' | 'unreachable' | 'not configured';
  url: string | null;
  detail?: string;
}

export interface DashboardData {
  project: { name: string; id: string; root: string; branch: string | null; commit: string | null; subject: string | null; privacy: string; capturePrompts: boolean; syncEnabled: boolean };
  graph: GraphMetadata | null;
  largest: Array<{ name: string; type: string; nodes: number }>;
  mostUsed: Array<{ name: string; type: string; dependents: number; path?: string }>;
  agents: AgentRow[];
  sessions: SessionSummary[];
  costs: CostRow[];
  memory: MemoryStats;
  memories: Memory[];
  gateway: GatewayStatus;
  /** Agent usage recorded on this machine, rolled up by day, week, model and session. Tokens are from transcripts; cost is tokens times catalog prices. */
  usage: LocalUsage;
  /** Gateway spend, when connected with management credentials. Absent means not fetched, never zero. */
  finops?: FinopsData;
}

/** One line of a rollup. Tokens are always real counts; `cost` says what is and is not priced. */
export interface UsageGroup {
  key: string;
  label: string;
  requests: number;
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  cost: CostResult;
}
export interface LocalUsage { day: UsageGroup[]; week: UsageGroup[]; model: UsageGroup[]; session: UsageGroup[] }

export interface FinopsRow { key: string; requests: number; input: number; output: number; cached: number; tokens: number; costUsd: number; errors: number; zeroCost: number; p95Ms: number | null }
export interface FinopsBudget { id: string; scope: string; name: string | null; capUsd: number; period: string; mode: string; active: boolean }
/** An agent session synced to the gateway, possibly from another machine. */
export interface SyncedSession { agent: string; id: string; repository: string | null; branch: string | null; state: string; startedAt: string; models: string[]; tokens: number | null; costUsd: number | null }
export interface FinopsData {
  state: 'ok' | 'no credentials' | 'error';
  detail?: string;
  days: number;
  total: { requests: number; tokens: number; costUsd: number; errors: number; zeroCost: number } | null;
  byModel: FinopsRow[];
  byDay: FinopsRow[];
  /** The daily rows folded into ISO weeks (Monday, UTC). */
  byWeek: FinopsRow[];
  sessions: SyncedSession[];
  budgets: FinopsBudget[];
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const mapRow = (r: Record<string, unknown>): FinopsRow => ({
  key: String(r.key ?? ''), requests: num(r.requests), input: num(r.input_tokens), output: num(r.output_tokens), cached: num(r.cached_tokens), tokens: num(r.total_tokens), costUsd: num(r.cost_usd),
  errors: num(r.errors), zeroCost: num(r.zero_cost_requests), p95Ms: r.p95_latency_ms == null ? null : num(r.p95_latency_ms),
});

/** The Monday (UTC) of the week a YYYY-MM-DD date falls in, as YYYY-MM-DD. */
export function weekStart(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** Daily rows into weekly ones. Sums are sums; the slowest day stands for the week's p95, never an average of percentiles. */
export function foldWeeks(days: FinopsRow[]): FinopsRow[] {
  const out = new Map<string, FinopsRow>();
  for (const r of days) {
    const key = weekStart(r.key);
    const w = out.get(key) ?? { key, requests: 0, input: 0, output: 0, cached: 0, tokens: 0, costUsd: 0, errors: 0, zeroCost: 0, p95Ms: null };
    w.requests += r.requests; w.input += r.input; w.output += r.output; w.cached += r.cached; w.tokens += r.tokens; w.costUsd += r.costUsd; w.errors += r.errors; w.zeroCost += r.zeroCost;
    if (r.p95Ms !== null) w.p95Ms = Math.max(w.p95Ms ?? 0, r.p95Ms);
    out.set(key, w);
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const DAY_MS = 86_400_000;

/** Real spend from the gateway management API. Never throws; failures come back as a state the screen explains. */
export async function fetchFinops(cfg: ResolvedConfig, fetchImpl?: typeof fetch, now = Date.now()): Promise<FinopsData> {
  const empty = { days: 30, total: null, byModel: [], byDay: [], byWeek: [], sessions: [], budgets: [] };
  const client = new ApiClient(cfg, { timeoutMs: 6000, maxAttempts: 1, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  if (!client.hasManagementCredentials) return { state: 'no credentials', detail: 'Run tokenistt login with a dashboard token.', ...empty };
  const since = new Date(now - 90 * DAY_MS).toISOString();
  type Rows = { rows: Array<Record<string, unknown>> };
  try {
    const [all, models, days, budgets, sessions] = await Promise.all([
      client.get<Rows>('management', '/v1/admin/usage/summary'),
      client.get<Rows>('management', '/v1/admin/usage/summary', { query: { group_by: 'model', limit: 40 } }),
      client.get<Rows>('management', '/v1/admin/usage/summary', { query: { group_by: 'day', limit: 120, since } }),
      client.get<Array<Record<string, unknown>>>('management', '/v1/admin/budgets'),
      client.get<Array<Record<string, unknown>>>('management', '/v1/admin/agent-sessions', { query: { limit: 60 } }).catch(() => [] as Array<Record<string, unknown>>),
    ]);
    const t = all.rows[0];
    const byDay = days.rows.map(mapRow).sort((x, y) => x.key.localeCompare(y.key));
    return {
      state: 'ok', days: 30,
      total: t ? { requests: num(t.requests), tokens: num(t.total_tokens), costUsd: num(t.cost_usd), errors: num(t.errors), zeroCost: num(t.zero_cost_requests) } : null,
      byModel: models.rows.map(mapRow),
      byDay,
      byWeek: foldWeeks(byDay),
      sessions: (Array.isArray(sessions) ? sessions : []).map((r) => {
        const tk = r.tokens as { total?: unknown } | null | undefined;
        return {
          agent: String(r.agent ?? ''), id: String(r.session_id ?? ''), repository: r.repository == null ? null : String(r.repository), branch: r.branch == null ? null : String(r.branch), state: String(r.state ?? ''),
          startedAt: String(r.started_at ?? ''), models: Array.isArray(r.models) ? r.models.map(String) : [], tokens: tk && tk.total != null ? num(tk.total) : null, costUsd: r.cost_usd == null ? null : num(r.cost_usd),
        };
      }),
      budgets: (Array.isArray(budgets) ? budgets : []).map((b) => ({
        id: String(b.id), scope: String(b.scope_type), name: b.name == null ? null : String(b.name), capUsd: num(b.cap_usd), period: String(b.period), mode: String(b.enforcement_mode), active: b.is_active !== false,
      })),
    };
  } catch (err) {
    return { state: 'error', detail: err instanceof Error ? err.message : String(err), ...empty };
  }
}

/** Saves the gateway's prices here when there are none yet or they are a day old, so session costs can be estimated. Never throws. */
export async function refreshPricesIfStale(cfg: ResolvedConfig, root: string, fetchImpl?: typeof fetch, maxAgeMs = DAY_MS): Promise<number | null> {
  const age = pricesAgeMs(root);
  if (age !== null && age < maxAgeMs) return null;
  const client = new ApiClient(cfg, { timeoutMs: 6000, maxAttempts: 1, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  if (!client.hasManagementCredentials) return null;
  try {
    const table = priceTableFromCatalog(await client.get<CatalogModel[]>('management', '/v1/admin/models'));
    if (Object.keys(table).length === 0) return 0;
    writePricesCache(root, table);
    return Object.keys(table).length;
  } catch {
    return null;
  }
}

interface UsageRecord {
  session_key: string;
  agent: string;
  session_id: string;
  model: string | null;
  at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/** The week a timestamp falls in, by its UTC date. */
export const dayOf = (iso: string): string => iso.slice(0, 10);

/**
 * Rolls local agent usage up by day, week, model and session. Each usage record has its own time and model, so a long
 * session lands on the days it actually ran. A group is priced from its own records; one with an unpriced model says so.
 */
export function rollupUsage(db: Database, prices: PriceTable | undefined): LocalUsage {
  const rows = db.prepare(
    `SELECT u.session_key, s.agent, s.session_id, u.model, COALESCE(u.at, s.last_event_at) AS at,
            u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens
       FROM agent_usage u JOIN agent_sessions s ON s.key = u.session_key
      ORDER BY at`).all() as unknown as UsageRecord[];
  const build = (keyOf: (r: UsageRecord) => string, labelOf: (key: string, r: UsageRecord) => string): UsageGroup[] => {
    const groups = new Map<string, { label: string; rows: UsageRecord[]; sessions: Set<string> }>();
    for (const r of rows) {
      const key = keyOf(r);
      const g = groups.get(key) ?? { label: labelOf(key, r), rows: [], sessions: new Set<string>() };
      g.rows.push(r);
      g.sessions.add(r.session_key);
      groups.set(key, g);
    }
    return [...groups.entries()].map(([key, g]) => ({
      key, label: g.label, requests: g.rows.length, sessions: g.sessions.size,
      input: g.rows.reduce((t, r) => t + r.input_tokens, 0), output: g.rows.reduce((t, r) => t + r.output_tokens, 0),
      cacheRead: g.rows.reduce((t, r) => t + r.cache_read_tokens, 0), cacheCreation: g.rows.reduce((t, r) => t + r.cache_creation_tokens, 0),
      total: g.rows.reduce((t, r) => t + r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens, 0),
      cost: priceUsage(g.rows, prices),
    }));
  };
  const newestFirst = (a: UsageGroup, b: UsageGroup): number => b.key.localeCompare(a.key);
  return {
    day: build((r) => dayOf(r.at), (k) => k).sort(newestFirst),
    week: build((r) => weekStart(dayOf(r.at)), (k) => k).sort(newestFirst),
    model: build((r) => r.model ?? 'unknown model', (k) => k).sort((a, b) => b.total - a.total),
    session: build((r) => r.session_key, (_k, r) => `${r.agent} ${r.session_id.slice(0, 8)}`).sort((a, b) => b.total - a.total),
  };
}

export function gatherLocal(project: Project, db: Database, home: string): Omit<DashboardData, 'gateway'> {
  const { root } = project.repo;
  refresh(root, db);
  const prices = readPrices(root);
  const now = Date.now();
  const sessions = listSessions(db, { limit: 200 }).map((r) => summarize(db, r, now, prices));
  const graph = readMetadata(db) ?? null;
  const index = graph ? GraphIndex.load(db) : undefined;

  const agents: AgentRow[] = ADAPTERS.map((a) => {
    const mine = sessions.filter((s) => s.agent === a.id);
    const connected = a.hookTargets(root, home).some((t) => isConnected(a, t));
    const state = mine.some((s) => s.state === 'active') ? 'active' : mine.some((s) => s.state === 'idle') ? 'idle' : connected ? 'connected' : 'not connected';
    return { id: a.id, name: a.displayName, installed: a.detectInstallation(process.env, home).installed, connected, state, verification: a.verification };
  });

  const costs: CostRow[] = ADAPTERS.map((a) => {
    const mine = sessions.filter((s) => s.agent === a.id);
    const known = mine.filter((s) => s.tokens);
    // What is known is shown as known, and what is not is counted beside it, instead of one unknown hiding the rest.
    return {
      agent: a.displayName, sessions: mine.length,
      tokens: known.reduce((t, s) => t + (s.tokens?.total ?? 0), 0),
      unreportedSessions: mine.length - known.length,
      cost: sumCosts(mine.map((s) => s.cost)),
    };
  });

  return {
    project: {
      name: project.config.name, id: project.config.projectId, root, branch: project.repo.branch ?? null, commit: project.repo.commit?.slice(0, 7) ?? null, subject: project.repo.commitSubject ?? null,
      privacy: project.config.privacy.commands, capturePrompts: project.config.privacy.capturePrompts, syncEnabled: project.config.sync.enabled,
    },
    graph,
    largest: index ? index.childrenOf('dir:.', 8).items.map((v) => ({ name: v.name, type: v.type, nodes: v.descendants })) : [],
    mostUsed: index ? index.mostUsed(8).map((v) => ({ name: v.name, type: v.type, dependents: v.dependents, ...(v.path ? { path: v.path } : {}) })) : [],
    agents,
    sessions,
    costs,
    usage: rollupUsage(db, prices),
    memory: memoryStats(db),
    memories: listMemories(db, { limit: 40 }),
  };
}

/** A quick probe that never holds up the dashboard. Nothing is sent but a health check. */
export async function probeGateway(cfg: ResolvedConfig, fetchImpl?: typeof fetch): Promise<GatewayStatus> {
  if (!cfg.hasFile && cfg.fromEnv.length === 0) return { state: 'not configured', url: null };
  const client = new ApiClient(cfg, { timeoutMs: 1500, maxAttempts: 1, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  try {
    await client.get('none', '/health');
    return { state: 'connected', url: cfg.apiUrl };
  } catch {
    return { state: 'unreachable', url: cfg.apiUrl };
  }
}

export function plainStatus(d: DashboardData): string {
  const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
  const active = d.sessions.filter((s) => s.state === 'active').length;
  return [
    `${d.project.name}  ${d.project.branch ?? '(no branch)'}  ${d.project.commit ?? '(no commits)'}`,
    `Graph:    ${d.graph ? `${sum(d.graph.nodes)} nodes, ${sum(d.graph.edges)} relationships, updated ${d.graph.generatedAt}` : 'not built; run tokenistt map'}`,
    `Agents:   ${d.agents.map((a) => `${a.name} ${a.state}`).join(', ')}`,
    `Sessions: ${d.sessions.length} recorded, ${active} active`,
    `Memory:   ${d.memory.active} active, ${d.memory.stale} stale`,
    `Gateway:  ${d.gateway.state}${d.gateway.url ? ` (${d.gateway.url})` : ''}`,
    '',
    'Run `tokenistt --help` for commands. On a terminal, `tokenistt` opens the dashboard.',
  ].join('\n');
}

/** What the prompt does with plain text: look in the graph and in memory. Local only; nothing leaves the machine. */
export function searchAll(db: Database, text: string): string[] {
  const out: string[] = [];
  if (readMetadata(db)) {
    for (const n of GraphIndex.load(db).search(text, 8)) out.push(`${n.type.padEnd(10)} ${n.name}${n.path ? `  ${n.path}${n.startLine ? `:${n.startLine}` : ''}` : ''}`);
  }
  for (const m of searchMemories(db, text, 4)) out.push(`memory     ${m.content.replace(/\s+/g, ' ').slice(0, 120)}`);
  return out;
}
