/**
 * routes/ingest.ts — POST /v1/ingest/events: usage events recorded outside the proxy.
 *
 * SDK instrumentation and the CLI's local queue report calls made directly to a provider so they
 * land in the same immutable `transactions` ledger the dashboard reads. Authenticated by the
 * caller's virtual key (the event belongs to that key's organization — never to one it names).
 *
 * Guarantees:
 *  - Cost is computed here, from the versioned catalog; a client-supplied cost is not accepted.
 *    Unknown model => COST_UNAVAILABLE and $0.00, never a guess.
 *  - Idempotent: the same `event_id` is stored once, however many times it is retried.
 *  - No prompt or completion content is accepted or stored.
 *  - Ingested spend counts towards budgets (they are computed from `transactions`) but cannot be
 *    blocked: the call already happened. Enforcement belongs at the proxy.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { getPool } from '../db/pool.js';
import { hashToken } from '../services/keyManager.js';
import { checkSlidingWindowRateLimit } from '../services/redisRateLimiter.js';
import { resolvePricingTierDynamic } from '../services/pricingDb.js';
import { calculateCostWithStatus } from '../services/pricing.js';
import { resolveAttribution } from '../services/workspaceResolver.js';
import { upsertHourlyRollup } from '../services/hourlyRollup.js';
import type { AuthContext } from '../db/auth.js';

export const ingestRouter = Router();

// Pre-auth throttle per client IP, ahead of the key lookup (the per-key Redis limit below needs a valid key).
const ipLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { message: 'Too many requests; slow down.', type: 'rate_limit_error' } },
});

export const INGEST_SCHEMA_VERSION = 1;
const MAX_BATCH = 500;
const BATCHES_PER_MINUTE = 120;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

const label = z.string().trim().min(1).max(200);
const tokens = z.number().int().min(0).max(10_000_000);

const EventSchema = z.object({
  event_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'event_id must be 1-128 chars of [A-Za-z0-9_.:-]'),
  occurred_at: z.string().datetime({ offset: true }),
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(200),
  endpoint: z.string().trim().min(1).max(200).optional(),
  input_tokens: tokens,
  output_tokens: tokens,
  cached_tokens: tokens.optional(),
  cache_creation_tokens: tokens.optional(),
  reasoning_tokens: tokens.optional(),
  latency_ms: z.number().int().min(0).max(3_600_000).optional(),
  status: z.enum(['success', 'error', 'timeout', 'rate_limited']).default('success'),
  error_code: z.string().trim().max(100).optional(),
  streamed: z.boolean().optional(),
  attribution: z.object({
    user: label.optional(), customer: label.optional(), lead: label.optional(), session: label.optional(),
    feature: label.optional(), environment: label.optional(), project: label.optional(), team: label.optional(),
    repo: label.optional(), ticket: label.optional(),
  }).strict().optional(),
}).strict();

const BodySchema = z.object({
  schema_version: z.literal(INGEST_SCHEMA_VERSION),
  source: z.enum(['sdk', 'cli']).default('cli'),
  events: z.array(z.unknown()).min(1).max(MAX_BATCH),
}).strict();

type Result = { event_id: string | null; status: 'accepted' | 'duplicate' | 'rejected'; error?: string };

const authFail = (res: Response, message: string) =>
  res.status(401).json({ error: { message, type: 'authentication_error' } });

ingestRouter.post('/ingest/events', ipLimiter, async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) {
    return void res.status(503).json({ error: { message: 'Database not configured' } });
  }
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return void authFail(res, 'Send your Tokenistt key as "Authorization: Bearer tktt_live_…".');

  const body = BodySchema.safeParse(req.body);
  if (!body.success) {
    return void res.status(400).json({
      error: { message: `Invalid request: ${body.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).slice(0, 5).join('; ')}` },
    });
  }

  try {
    const pool = getPool();
    const key = (await pool.query<{ id: string; organization_id: string; workspace_id: string | null; cost_center: string; public_id: string }>(
      `SELECT vk.id::text, vk.organization_id::text, vk.workspace_id::text, vk.public_id::text,
              COALESCE(ws.cost_center, 'default') AS cost_center
         FROM virtual_keys vk LEFT JOIN workspaces ws ON ws.id = vk.workspace_id
        WHERE vk.key_hash = $1 AND vk.status = 'active' AND (vk.expires_at IS NULL OR vk.expires_at > now())`,
      [hashToken(token)])).rows[0];
    if (!key) return void authFail(res, 'Invalid or revoked key.');

    const limit = await checkSlidingWindowRateLimit(`ingest:${key.id}`, BATCHES_PER_MINUTE, 60);
    if (!limit.allowed) {
      res.setHeader('retry-after', String(Math.max(1, limit.resetAt - Math.floor(Date.now() / 1000))));
      return void res.status(429).json({ error: { message: 'Ingest rate limit exceeded; retry later.', type: 'rate_limit_error' } });
    }

    const org = BigInt(key.organization_id);
    const auth = { organizationId: org } as AuthContext;
    const now = Date.now();
    const hourStart = now - (now % 3_600_000);
    const results: Result[] = [];

    for (const raw of body.data.events) {
      const parsed = EventSchema.safeParse(raw);
      const rawId = (raw as { event_id?: unknown } | null)?.event_id;
      if (!parsed.success) {
        results.push({
          event_id: typeof rawId === 'string' ? rawId.slice(0, 128) : null, status: 'rejected',
          error: parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        continue;
      }
      const e = parsed.data;
      const at = Date.parse(e.occurred_at);
      if (at < now - MAX_AGE_MS || at > now + MAX_FUTURE_MS) {
        results.push({ event_id: e.event_id, status: 'rejected', error: 'occurred_at must be within the last 30 days and not in the future.' });
        continue;
      }

      const a = e.attribution ?? {};
      const tier = e.status === 'success' ? await resolvePricingTierDynamic(e.provider, e.model) : null;
      const cost = e.status === 'success'
        ? calculateCostWithStatus(e.provider, e.model, e.input_tokens, e.output_tokens, e.cached_tokens ?? 0, e.cache_creation_tokens ?? 0, e.reasoning_tokens ?? 0, tier)
        : null;
      const costUsd = cost?.cost ?? 0;

      const attr = await resolveAttribution(auth, {
        'x-tokenistt-team': a.team, 'x-tokenistt-project': a.project, 'x-tokenistt-environment': a.environment,
        'x-tokenistt-repo': a.repo, 'x-tokenistt-ticket': a.ticket, 'x-tokenistt-feature': a.feature,
        'x-tokenistt-customer': a.customer, 'x-tokenistt-employee': a.user,
      });

      const ins = await pool.query(
        `INSERT INTO transactions (
           organization_id, workspace_id, virtual_key_id, actor, provider, model, endpoint, request_id,
           cost_center, project_tag, cost_usd, amortized_cost_usd, input_cost_usd, output_cost_usd,
           prompt_tokens, completion_tokens, total_tokens, cache_creation_tokens, cache_read_tokens,
           status, error_code, duration_ms, metadata, team_id, project_id, environment,
           repo, ticket, sprint, feature, customer, employee, created_at,
           reasoning_tokens, cost_status)
         SELECT $1::bigint,$2::bigint,$3::bigint,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,
                $11::numeric,$11::numeric,$12::numeric,$13::numeric,$14::int,$15::int,$16::int,$17::int,$18::int,
                $19::text,$20::text,$21::int,$22::jsonb,$23::bigint,$24::bigint,$25::text,
                $26::text,$27::text,NULL,$28::text,$29::text,$30::text,$31::timestamptz,
                $32::int,$33::text
          WHERE NOT EXISTS (SELECT 1 FROM transactions WHERE request_id = $8)`,
        [
          key.organization_id, key.workspace_id, key.id, a.user ?? null, e.provider.toLowerCase(), e.model,
          e.endpoint ?? '/chat/completions', `ing:${key.organization_id}:${e.event_id}`, key.cost_center, a.project ?? null,
          costUsd.toFixed(6), (cost?.inputCost ?? 0).toFixed(6), (cost?.outputCost ?? 0).toFixed(6),
          e.input_tokens, e.output_tokens, e.input_tokens + e.output_tokens, e.cache_creation_tokens ?? 0, e.cached_tokens ?? 0,
          e.status, e.error_code ?? null, e.latency_ms ?? null,
          JSON.stringify({
            source: `ingest:${body.data.source}`, schema_version: INGEST_SCHEMA_VERSION, streamed: e.streamed ?? false,
            cost_status: cost?.costStatus ?? 'NOT_APPLICABLE', lead: a.lead ?? null, session: a.session ?? null,
          }),
          attr.teamId?.toString() ?? null, attr.projectId?.toString() ?? null, attr.environment,
          attr.repo, attr.ticket, attr.feature, attr.customer, attr.employee, new Date(at).toISOString(),
          e.reasoning_tokens ?? 0, cost?.costStatus ?? 'NOT_APPLICABLE',
        ],
      );

      if (ins.rowCount === 0) {
        results.push({ event_id: e.event_id, status: 'duplicate' });
        continue;
      }
      results.push({ event_id: e.event_id, status: 'accepted' });
      // The hourly rollup buckets by "now", so only events from this hour may feed it; older ones are in
      // `transactions` (what usage/cost queries read) and would otherwise be counted in the wrong hour.
      if (at >= hourStart) upsertHourlyRollup({
        organizationId: org, teamId: attr.teamId, projectId: attr.projectId, provider: e.provider.toLowerCase(), model: e.model,
        costUsd, totalTokens: e.input_tokens + e.output_tokens, inputTokens: e.input_tokens, outputTokens: e.output_tokens,
        isError: e.status !== 'success',
      }).catch(() => {});
    }

    const count = (s: Result['status']) => results.filter(r => r.status === s).length;
    res.json({
      schema_version: INGEST_SCHEMA_VERSION,
      accepted: count('accepted'), duplicates: count('duplicate'), rejected: count('rejected'),
      results,
    });
  } catch (err: any) {
    // 503 (not 500): the client keeps the batch queued and retries; event_id makes the retry safe.
    console.error('[Ingest]', err.message);
    res.status(503).json({ error: { message: 'Could not store events; retry later.' } });
  }
});
