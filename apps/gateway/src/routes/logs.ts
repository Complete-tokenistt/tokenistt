/**
 * routes/logs.ts — GET /v1/logs: request history for the calling virtual key.
 *
 * Read-only lookup by key hash (no budget reservation, no rate-limit side effects), so
 * developers and the CLI can `tail` their own traffic. A key only ever sees its own rows.
 */
import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool.js';
import { hashToken } from '../services/keyManager.js';

export const logsRouter = Router();

logsRouter.get('/logs', async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: { message: 'Database not configured' } });
    return;
  }
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: { message: 'Send your Tokenistt key as "Authorization: Bearer tktt_live_…".', type: 'authentication_error' } });
    return;
  }

  try {
    const pool = getPool();
    const key = (await pool.query<{ id: string }>(
      `SELECT id::text FROM virtual_keys WHERE key_hash = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())`,
      [hashToken(token)]
    )).rows[0];
    if (!key) {
      res.status(401).json({ error: { message: 'Invalid or revoked key.', type: 'authentication_error' } });
      return;
    }

    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const before = /^\d+$/.test(String(req.query.before ?? '')) ? String(req.query.before) : null;
    const status = req.query.status ? String(req.query.status) : null;

    const { rows } = await pool.query(
      `SELECT id::text, request_id, provider, model, cost_usd::text, prompt_tokens, completion_tokens,
              status, error_code, duration_ms, created_at
         FROM transactions
        WHERE virtual_key_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) AND ($4::text IS NULL OR status = $4)
        ORDER BY transactions.id DESC LIMIT $3`,
      [key.id, before, limit, status]
    );
    res.json({ data: rows, next_before: rows.length === limit ? rows[rows.length - 1].id : null });
  } catch (err: any) {
    console.error('[Logs]', err.message);
    res.status(500).json({ error: { message: 'Internal error' } });
  }
});

/**
 * GET /v1/usage/me — what the calling key has spent: today, this month, per model, and budget headroom.
 * Authenticated by the virtual key itself, so editors and SDKs never need an admin credential.
 */
logsRouter.get('/usage/me', async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: { message: 'Database not configured' } });
    return;
  }
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: { message: 'Send your Tokenistt key as "Authorization: Bearer tktt_live_…".', type: 'authentication_error' } });
    return;
  }
  try {
    const pool = getPool();
    const key = (await pool.query(
      `SELECT id::text, name, key_prefix, budget_cap_usd::float AS cap, budget_period
         FROM virtual_keys WHERE key_hash = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())`,
      [hashToken(token)]
    )).rows[0];
    if (!key) {
      res.status(401).json({ error: { message: 'Invalid or revoked key.', type: 'authentication_error' } });
      return;
    }

    const totals = (await pool.query(
      `SELECT
         count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int                       AS today_requests,
         COALESCE(sum(cost_usd) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::float   AS today_cost,
         count(*)::int                                                                             AS month_requests,
         COALESCE(sum(cost_usd), 0)::float                                                         AS month_cost,
         count(*) FILTER (WHERE status <> 'success')::int                                          AS month_errors,
         max(created_at)                                                                           AS last_request_at
       FROM transactions WHERE virtual_key_id = $1 AND created_at >= date_trunc('month', now())`,
      [key.id]
    )).rows[0];
    const models = (await pool.query(
      `SELECT provider, model, count(*)::int AS requests, COALESCE(sum(cost_usd), 0)::float AS cost_usd
         FROM transactions WHERE virtual_key_id = $1 AND created_at >= date_trunc('month', now())
        GROUP BY provider, model ORDER BY cost_usd DESC, requests DESC LIMIT 5`,
      [key.id]
    )).rows;

    const spentInPeriod = key.budget_period === 'daily' ? totals.today_cost : key.budget_period === 'monthly' ? totals.month_cost : null;
    res.json({
      key: { name: key.name, prefix: key.key_prefix },
      today: { requests: totals.today_requests, cost_usd: totals.today_cost },
      month: { requests: totals.month_requests, cost_usd: totals.month_cost, errors: totals.month_errors },
      last_request_at: totals.last_request_at,
      budget: key.cap == null || spentInPeriod == null
        ? null
        : { cap_usd: key.cap, period: key.budget_period, spent_usd: spentInPeriod, remaining_usd: Math.max(0, key.cap - spentInPeriod), percent_used: Math.round((spentInPeriod / key.cap) * 1000) / 10 },
      top_models: models,
    });
  } catch (err: any) {
    console.error('[Usage]', err.message);
    res.status(500).json({ error: { message: 'Internal error' } });
  }
});

