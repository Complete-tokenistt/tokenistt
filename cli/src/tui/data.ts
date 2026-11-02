/** What the dashboard shows, gathered from real sources. A value with no source is null and renders as unknown. */
import { ApiClient } from '../api/client.js';
import { isConnected } from '../agents/connect.js';
import { ADAPTERS } from '../agents/registry.js';
import { listSessions, readPrices, refresh, summarize, type SessionSummary } from '../agents/sessions.js';
import type { ResolvedConfig } from '../config/store.js';
import { readMetadata, type GraphMetadata } from '../graph/store.js';
import { GraphIndex } from '../graph/query.js';
import { memoryStats, listMemories, type Memory, type MemoryStats } from '../memory/store.js';
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
