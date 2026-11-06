/** What the dashboard shows, gathered from real sources. A value with no source is null and renders as unknown. */
import { ApiClient } from '../api/client.js';
import { isConnected } from '../agents/connect.js';
import { ADAPTERS } from '../agents/registry.js';
import { listSessions, readPrices, refresh, summarize, type SessionSummary } from '../agents/sessions.js';
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
  tokens: number | null;
  costUsd: number | null;
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
  /** Gateway spend, when connected with management credentials. Absent means not fetched, never zero. */
  finops?: FinopsData;
}

export interface FinopsRow { key: string; requests: number; tokens: number; costUsd: number; errors: number; p95Ms: number | null }
export interface FinopsBudget { id: string; scope: string; name: string | null; capUsd: number; period: string; mode: string; active: boolean }
export interface FinopsData {
  state: 'ok' | 'no credentials' | 'error';
  detail?: string;
  days: number;
  total: { requests: number; tokens: number; costUsd: number; errors: number; zeroCost: number } | null;
  byModel: FinopsRow[];
  byDay: FinopsRow[];
  budgets: FinopsBudget[];
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const mapRow = (r: Record<string, unknown>): FinopsRow => ({
  key: String(r.key ?? ''), requests: num(r.requests), tokens: num(r.total_tokens), costUsd: num(r.cost_usd), errors: num(r.errors), p95Ms: r.p95_latency_ms == null ? null : num(r.p95_latency_ms),
});

/** Real spend from the gateway management API (30 days). Never throws; failures come back as a state the screen explains. */
export async function fetchFinops(cfg: ResolvedConfig, fetchImpl?: typeof fetch): Promise<FinopsData> {
  const empty = { days: 30, total: null, byModel: [], byDay: [], budgets: [] };
  const client = new ApiClient(cfg, { timeoutMs: 4000, maxAttempts: 1, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  if (!client.hasManagementCredentials) return { state: 'no credentials', detail: 'Run tokenistt login with a dashboard token.', ...empty };
  try {
    const [all, models, days, budgets] = await Promise.all([
      client.get<{ rows: Array<Record<string, unknown>> }>('management', '/v1/admin/usage/summary'),
      client.get<{ rows: Array<Record<string, unknown>> }>('management', '/v1/admin/usage/summary', { query: { group_by: 'model', limit: 8 } }),
      client.get<{ rows: Array<Record<string, unknown>> }>('management', '/v1/admin/usage/summary', { query: { group_by: 'day', limit: 14 } }),
      client.get<Array<Record<string, unknown>>>('management', '/v1/admin/budgets'),
    ]);
    const t = all.rows[0];
    return {
      state: 'ok', days: 30,
      total: t ? { requests: num(t.requests), tokens: num(t.total_tokens), costUsd: num(t.cost_usd), errors: num(t.errors), zeroCost: num(t.zero_cost_requests) } : null,
      byModel: models.rows.map(mapRow),
      byDay: days.rows.map(mapRow).sort((a, b) => a.key.localeCompare(b.key)),
      budgets: (Array.isArray(budgets) ? budgets : []).map((b) => ({
        id: String(b.id), scope: String(b.scope_type), name: b.name == null ? null : String(b.name), capUsd: num(b.cap_usd), period: String(b.period), mode: String(b.enforcement_mode), active: b.is_active !== false,
      })),
    };
  } catch (err) {
    return { state: 'error', detail: err instanceof Error ? err.message : String(err), ...empty };
  }
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
    // A total is only a number if every session in it is: one unknown makes the sum unknown, not smaller.
    return {
      agent: a.displayName, sessions: mine.length,
      tokens: mine.length && known.length === mine.length ? known.reduce((t, s) => t + (s.tokens?.total ?? 0), 0) : null,
      costUsd: mine.length && mine.every((s) => s.cost.costUsd !== null) ? mine.reduce((t, s) => t + (s.cost.costUsd ?? 0), 0) : null,
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
