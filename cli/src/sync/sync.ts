/**
 * Sends summaries to your gateway when sync is on. It is opt-in, and sends what is listed in buildPayload and nothing
 * else: repo-relative paths, no prompts, no source, no transcripts. A failed send moves no cursor, so nothing is lost
 * offline and the next run covers the gap. The gateway's upserts make a repeat harmless.
 */
import type { ApiClient } from '../api/client.js';
import { listSessions, readPrices, refresh, summarize, type SessionSummary } from '../agents/sessions.js';
import { GraphIndex } from '../graph/query.js';
import { readMetadata } from '../graph/store.js';
import type { Database } from '../store/db.js';
import type { Project } from '../store/project.js';
import type { Memory } from '../memory/store.js';

const MAX_SESSIONS = 200;
const MAX_MEMORIES = 500;
const MAX_FILES = 500;
const INGEST_BATCH = 500;

const getMeta = (db: Database, key: string): string | undefined => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
const setMeta = (db: Database, key: string, value: string): void => { db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value); };

function sessionPayload(s: SessionSummary): Record<string, unknown> {
  return {
    agent: s.agent, session_id: s.id, branch: s.branch, state: s.state, started_at: s.startedAt, ended_at: s.endedAt, last_event_at: s.lastEventAt, models: s.models.slice(0, 20),
    tokens: s.tokens ? { input: s.tokens.input, output: s.tokens.output, cache_read: s.tokens.cacheRead, cache_creation: s.tokens.cacheCreation, total: s.tokens.total, requests: s.tokens.requests } : null,
    cost_usd: s.cost.costUsd, cost_source: s.cost.source, counts: s.counts,
    changed_files: [...s.files.created, ...s.files.modified, ...s.files.deleted].slice(0, MAX_FILES),
  };
}

function graphPayload(db: Database): Record<string, unknown> | null {
  const metadata = readMetadata(db);
  if (!metadata) return null;
  const index = GraphIndex.load(db);
  const modules = [...index.nodes.values()].filter((n) => n.type === 'module').slice(0, 500).map((m) => ({
    name: m.name,
    path: m.path ?? '.',
    files: m.path && m.path !== '.' ? [...index.nodes.values()].filter((n) => n.type === 'file' && n.path?.startsWith(`${m.path}/`)).length : metadata.files.total,
    dependencies: index.relations(m.id, 200).outgoing.filter((r) => r.edge === 'DEPENDS_ON' && r.type === 'module').map((r) => r.name),
  }));
  return { stats: { nodes: metadata.nodes, edges: metadata.edges, files: metadata.files.total }, modules };
}

export interface SyncPlan {
  payload: Record<string, unknown>;
  sessions: number;
  memories: number;
  graph: boolean;
  newSessionCursor: string | null;
  newMemoryCursor: string | null;
}

/** Only what changed since the last successful sync. */
export function buildPayload(project: Project, db: Database, now = Date.now()): SyncPlan {
  refresh(project.repo.root, db);
  const prices = readPrices(project.repo.root);
  const sessionCursor = getMeta(db, 'sync_session_cursor') ?? '';
  const memoryCursor = getMeta(db, 'sync_memory_cursor') ?? '';
  const sessions = listSessions(db, { limit: 5000 }).filter((r) => r.last_event_at > sessionCursor).slice(-MAX_SESSIONS).map((r) => summarize(db, r, now, prices));
  const memories = db.prepare(`SELECT * FROM memories WHERE updated_at > ? ORDER BY updated_at LIMIT ?`).all(memoryCursor, MAX_MEMORIES) as unknown as Memory[];
  const metadata = readMetadata(db);
  const graphFresh = metadata && metadata.generatedAt !== getMeta(db, 'sync_graph_at');
  const repo = project.repo;
  const payload = {
    schema_version: 1,
    repository: { project_key: project.config.projectId, name: project.config.name, ...(repo.branch ? { branch: repo.branch } : {}), ...(repo.commit ? { commit: repo.commit } : {}) },
    ...(graphFresh ? { graph: graphPayload(db) } : {}),
    sessions: sessions.map(sessionPayload),
    memories: memories.map((m) => ({
      // Edits make a new row but mean the same fact, so the key is the fact's where it has one.
      key: (m.dedupe_key ?? m.id).slice(0, 200), category: m.category, content: m.content.slice(0, 4000), source_kind: m.source_kind, source_ref: m.source_ref.slice(0, 500), status: m.status, updated_at: m.updated_at,
    })),
  };
  const latest = (values: string[], fallback: string): string | null => values.reduce((a, b) => (b > a ? b : a), fallback) || null;
  return {
    payload, sessions: sessions.length, memories: memories.length, graph: !!graphFresh,
    newSessionCursor: latest(sessions.map((s) => s.lastEventAt), sessionCursor),
    newMemoryCursor: latest(memories.map((m) => m.updated_at), memoryCursor),
  };
}

export interface SyncResult {
  sessions: number;
  memories: number;
  graph: boolean;
  ledgerEvents: { accepted: number; duplicate: number; rejected: number; skippedProxied: number; skippedNoModel: number } | null;
}

const PROVIDER: Record<string, string> = { 'claude-code': 'anthropic', codex: 'openai' };

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Opt-in, for API-billed usage only: agent usage goes to the gateway's ledger, where it counts toward budgets. A session
 * that already ran through this gateway is skipped, or it would be counted twice.
 */
export async function sendLedger(project: Project, db: Database, client: ApiClient): Promise<NonNullable<SyncResult['ledgerEvents']>> {
  const out = { accepted: 0, duplicate: 0, rejected: 0, skippedProxied: 0, skippedNoModel: 0 };
  const gatewayHost = hostOf(client.baseUrl);
  const rows = db.prepare(`SELECT u.session_key, u.request_id, u.model, u.at, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens, s.agent, s.session_id, s.proxy_host, s.started_at
    FROM agent_usage u JOIN agent_sessions s ON s.key = u.session_key
    WHERE NOT EXISTS (SELECT 1 FROM agent_ledger_sent l WHERE l.session_key = u.session_key AND l.request_id = u.request_id)`).all() as Array<{ session_key: string; request_id: string; model: string | null; at: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; agent: string; session_id: string; proxy_host: string | null; started_at: string }>;
  const mark = db.prepare('INSERT OR IGNORE INTO agent_ledger_sent (session_key, request_id) VALUES (?, ?)');
  const eligible = rows.filter((r) => {
    if (r.proxy_host && r.proxy_host === gatewayHost) { out.skippedProxied++; return false; }
    if (!r.model || !PROVIDER[r.agent]) { out.skippedNoModel++; return false; }
    return true;
  });
  for (let i = 0; i < eligible.length; i += INGEST_BATCH) {
    const batch = eligible.slice(i, i + INGEST_BATCH);
    const res = await client.post<{ results: Array<{ status: string }> }>('key', '/v1/ingest/events', {
      schema_version: 1, source: 'cli',
      events: batch.map((r) => ({
        event_id: `agent.${r.session_id}.${r.request_id}`.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 128),
        // A transcript line without a usable time falls back to the session start.
        occurred_at: r.at && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : r.started_at,
        provider: PROVIDER[r.agent], model: r.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cached_tokens: r.cache_read_tokens, cache_creation_tokens: r.cache_creation_tokens,
        attribution: { project: project.config.name, session: r.session_id, feature: `agent:${r.agent}` },
      })),
    }, { idempotent: true });
    batch.forEach((r, j) => {
      const status = res.results[j]?.status;
      if (status === 'accepted') out.accepted++;
      else if (status === 'duplicate') out.duplicate++;
      else out.rejected++;
      if (status === 'accepted' || status === 'duplicate') mark.run(r.session_key, r.request_id);
    });
  }
  return out;
}

export async function runSync(project: Project, db: Database, client: ApiClient): Promise<SyncResult> {
  const plan = buildPayload(project, db);
  await client.post('key', '/v1/sync', plan.payload, { idempotent: true });
  // Only after the gateway has it, so a failure resends rather than skips.
  if (plan.newSessionCursor) setMeta(db, 'sync_session_cursor', plan.newSessionCursor);
  if (plan.newMemoryCursor) setMeta(db, 'sync_memory_cursor', plan.newMemoryCursor);
  const generatedAt = readMetadata(db)?.generatedAt;
  if (plan.graph && generatedAt) setMeta(db, 'sync_graph_at', generatedAt);
  const ledgerEvents = project.config.sync.ledger ? await sendLedger(project, db, client) : null;
  return { sessions: plan.sessions, memories: plan.memories, graph: plan.graph, ledgerEvents };
}
