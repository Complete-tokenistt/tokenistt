/**
 * routes/sync.ts — POST /v1/sync: repository summaries from the CLI, when a user switches sync on.
 *
 * Authenticated by virtual key; everything lands in that key's organization, never one the caller names.
 * Guarantees:
 *  - Schemas are strict, so a field like a prompt or an absolute path is rejected rather than stored.
 *  - Idempotent: the same payload twice changes nothing, and an older update never overwrites a newer one.
 *  - Agent sessions stay out of `transactions`, so they never affect budgets. A client-supplied cost is an estimate,
 *    stored and labelled as one.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { getPool } from '../db/pool.js';
import { hashToken } from '../services/keyManager.js';
import { checkSlidingWindowRateLimit } from '../services/redisRateLimiter.js';

export const syncRouter = Router();

export const SYNC_SCHEMA_VERSION = 1;
const BATCHES_PER_MINUTE = 60;

const ipLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many requests; slow down.', type: 'rate_limit_error' } },
});

const label = z.string().trim().min(1).max(200);
/** Repo-relative only, so a machine's directory layout and usernames never leave it. */
const repoPath = z.string().min(1).max(1000).refine((p) => !p.startsWith('/') && !p.startsWith('\\') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'), 'must be a repo-relative path');
const count = z.number().int().min(0).max(1_000_000_000_000);
const when = z.string().datetime({ offset: true });

const Session = z.object({
  agent: label,
  session_id: label,
  branch: label.nullable().optional(),
  state: z.enum(['active', 'idle', 'inactive', 'ended']),
  started_at: when,
  ended_at: when.nullable().optional(),
  last_event_at: when,
  models: z.array(label).max(20).default([]),
  tokens: z.object({ input: count, output: count, cache_read: count, cache_creation: count, total: count, requests: count }).strict().nullable().optional(),
  cost_usd: z.number().min(0).max(1_000_000).nullable().optional(),
  cost_source: z.enum(['catalog_estimate', 'unknown']).default('unknown'),
  counts: z.record(z.string().max(40), count).default({}),
  changed_files: z.array(repoPath).max(500).default([]),
}).strict();

const Memory = z.object({
  key: label,
  category: label,
  content: z.string().trim().min(1).max(4000),
  source_kind: label,
  source_ref: z.string().max(500),
  status: z.enum(['active', 'stale', 'retired', 'superseded']),
  updated_at: when,
}).strict();

const Graph = z.object({
  stats: z.object({ nodes: z.record(z.string().max(40), count), edges: z.record(z.string().max(40), count), files: count }).strict(),
  modules: z.array(z.object({ name: label, path: z.union([z.literal('.'), repoPath]), files: count, dependencies: z.array(label).max(200) }).strict()).max(500).default([]),
}).strict();

const Body = z.object({
  schema_version: z.literal(SYNC_SCHEMA_VERSION),
  repository: z.object({ project_key: z.string().regex(/^repo_[0-9a-f]{16}$/), name: label, branch: label.nullable().optional(), commit: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().optional() }).strict(),
  graph: Graph.nullable().optional(),
  sessions: z.array(Session).max(200).default([]),
  memories: z.array(Memory).max(500).default([]),
}).strict();

const authFail = (res: Response, message: string) => res.status(401).json({ error: { message, type: 'authentication_error' } });

syncRouter.post('/sync', ipLimiter, async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) return void res.status(503).json({ error: { message: 'Database not configured' } });
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return void authFail(res, 'Send your Tokenistt key as "Authorization: Bearer tktt_live_…".');

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return void res.status(400).json({ error: { message: `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).slice(0, 5).join('; ')}` } });
  }
  const body = parsed.data;

  const pool = getPool();
  const client = await pool.connect();
  try {
    const key = (await client.query<{ id: string; organization_id: string }>(
      `SELECT id::text, organization_id::text FROM virtual_keys WHERE key_hash = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())`, [hashToken(token)])).rows[0];
    if (!key) return void authFail(res, 'Invalid or revoked key.');

    const limit = await checkSlidingWindowRateLimit(`sync:${key.id}`, BATCHES_PER_MINUTE, 60);
    if (!limit.allowed) {
      res.setHeader('retry-after', String(Math.max(1, limit.resetAt - Math.floor(Date.now() / 1000))));
      return void res.status(429).json({ error: { message: 'Sync rate limit exceeded; retry later.', type: 'rate_limit_error' } });
    }

    const org = key.organization_id;
    await client.query('BEGIN');
    const repo = (await client.query<{ id: string; public_id: string }>(
      `INSERT INTO code_repositories (organization_id, project_key, name, branch, commit_sha, graph_stats, graph_modules)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organization_id, project_key) DO UPDATE SET
         name = EXCLUDED.name, branch = EXCLUDED.branch, commit_sha = EXCLUDED.commit_sha, last_synced_at = now(),
         graph_stats = COALESCE(EXCLUDED.graph_stats, code_repositories.graph_stats),
         graph_modules = COALESCE(EXCLUDED.graph_modules, code_repositories.graph_modules)
       RETURNING id::text, public_id::text`,
      [org, body.repository.project_key, body.repository.name, body.repository.branch ?? null, body.repository.commit ?? null,
        body.graph ? JSON.stringify(body.graph.stats) : null, body.graph ? JSON.stringify(body.graph.modules) : null])).rows[0]!;

    let sessions = 0;
    for (const s of body.sessions) {
      const r = await client.query(
        `INSERT INTO agent_sessions (organization_id, repository_id, agent, session_id, branch, state, started_at, ended_at, last_event_at, models, tokens, cost_usd, cost_source, counts, changed_files)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (organization_id, repository_id, agent, session_id) DO UPDATE SET
           branch = EXCLUDED.branch, state = EXCLUDED.state, ended_at = EXCLUDED.ended_at, last_event_at = EXCLUDED.last_event_at, models = EXCLUDED.models,
           tokens = EXCLUDED.tokens, cost_usd = EXCLUDED.cost_usd, cost_source = EXCLUDED.cost_source, counts = EXCLUDED.counts, changed_files = EXCLUDED.changed_files
         WHERE EXCLUDED.last_event_at >= agent_sessions.last_event_at`,
        [org, repo.id, s.agent, s.session_id, s.branch ?? null, s.state, s.started_at, s.ended_at ?? null, s.last_event_at, s.models, s.tokens ? JSON.stringify(s.tokens) : null,
          s.cost_source === 'catalog_estimate' ? s.cost_usd ?? null : null, s.cost_usd === null || s.cost_usd === undefined ? 'unknown' : s.cost_source, JSON.stringify(s.counts), JSON.stringify(s.changed_files)]);
      sessions += r.rowCount ?? 0;
    }

    let memories = 0;
    for (const m of body.memories) {
      const r = await client.query(
        `INSERT INTO repository_memories (organization_id, repository_id, memory_key, category, content, source_kind, source_ref, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (organization_id, repository_id, memory_key) DO UPDATE SET
           category = EXCLUDED.category, content = EXCLUDED.content, source_kind = EXCLUDED.source_kind, source_ref = EXCLUDED.source_ref, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.updated_at >= repository_memories.updated_at`,
        [org, repo.id, m.key, m.category, m.content, m.source_kind, m.source_ref, m.status, m.updated_at]);
      memories += r.rowCount ?? 0;
    }
    await client.query('COMMIT');
    res.json({ repository: repo.public_id, sessions, memories, graph: !!body.graph });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[Sync]', err.message);
    res.status(500).json({ error: { message: 'Internal error' } });
  } finally {
    client.release();
  }
});
