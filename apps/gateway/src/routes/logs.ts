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
        ORDER BY id DESC LIMIT $3`,
      [key.id, before, limit, status]
    );
    res.json({ data: rows, next_before: rows.length === limit ? rows[rows.length - 1].id : null });
  } catch (err: any) {
    console.error('[Logs]', err.message);
    res.status(500).json({ error: { message: 'Internal error' } });
  }
});
