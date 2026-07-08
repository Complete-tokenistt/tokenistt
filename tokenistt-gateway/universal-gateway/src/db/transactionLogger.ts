/**
 * db/transactionLogger.ts — Async event logger to Postgres `transactions`.
 *
 * Writes one immutable row per API call (the FinOps ledger).
 * This is fire-and-forget: errors are logged but never bubble up to the
 * HTTP response so the gateway stays "fail-open" — a DB hiccup never
 * blocks an AI call.
 *
 * If DATABASE_URL is not set the logger silently skips (dev mode).
 */

import { getPool } from './pool.js';
import type { AuthContext } from './auth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransactionPayload {
  auth:              AuthContext;
  provider:          string;
  model:             string;
  endpoint:          string;
  requestId:         string;
  promptTokens:      number;
  completionTokens:  number;
  totalTokens:       number;
  inputCostUsd:      number;
  outputCostUsd:     number;
  costUsd:           number;
  durationMs:        number;
  status:            'success' | 'error' | 'timeout' | 'rate_limited';
  errorCode?:        string;
  projectTag?:       string;
  metadata?:         Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

let mockLogger: ((payload: TransactionPayload) => Promise<string | null>) | null = null;

export function setMockLogger(fn: typeof mockLogger) {
  mockLogger = fn;
}

/**
 * Writes one row to `transactions` asynchronously.
 * Returns the public_id of the new row, or null if the DB is unavailable.
 */
export async function logTransaction(
  payload: TransactionPayload,
): Promise<string | null> {
  if (mockLogger) {
    return mockLogger(payload);
  }
  if (!process.env.DATABASE_URL) {
    // Dev mode — just console log and skip DB write
    console.log(
      `[TxLog] ${payload.status.toUpperCase()} | ` +
      `${payload.provider}:${payload.model} | ` +
      `tokens=${payload.totalTokens} | ` +
      `cost=$${payload.costUsd.toFixed(6)} | ` +
      `${payload.durationMs}ms | actor=${payload.auth.actor}`
    );
    return null;
  }

  try {
    const pool = getPool();

    // ── Resolve/Upsert User for Attribution ──────────────────────────────────
    let userId: string | null = null;
    const orgId = payload.auth.organizationId !== BigInt(0) ? payload.auth.organizationId : null;
    
    if (orgId && payload.auth.actor) {
      try {
        const userRes = await pool.query<{ id: string }>(
          `
          INSERT INTO users (organization_id, external_ref, email, display_name)
          VALUES ($1, $2, CASE WHEN $2 LIKE '%@%' THEN $2 ELSE NULL END, SPLIT_PART($2, '@', 1))
          ON CONFLICT (organization_id, external_ref) 
          DO UPDATE SET external_ref = EXCLUDED.external_ref
          RETURNING id::text
          `,
          [orgId, payload.auth.actor]
        );
        userId = userRes.rows[0]?.id ?? null;
      } catch (err: any) {
        console.error('[TxLog] Failed to upsert user for attribution:', err.message);
      }
    }

    const { rows } = await pool.query<{ public_id: string }>(
      `
      INSERT INTO transactions (
        organization_id,
        workspace_id,
        virtual_key_id,
        user_id,
        actor,
        provider,
        model,
        endpoint,
        request_id,
        cost_center,
        project_tag,
        cost_usd,
        amortized_cost_usd,
        input_cost_usd,
        output_cost_usd,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        status,
        error_code,
        duration_ms,
        metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22
      )
      RETURNING public_id::text
      `,
      [
        orgId,
        payload.auth.workspaceId,
        payload.auth.virtualKeyId !== BigInt(0) ? payload.auth.virtualKeyId : null,
        userId ? BigInt(userId) : null,
        payload.auth.actor,
        payload.provider,
        payload.model,
        payload.endpoint,
        payload.requestId,
        payload.auth.costCenter,
        payload.projectTag ?? null,
        payload.costUsd.toFixed(6),
        payload.costUsd.toFixed(6),  // amortized = cost
        payload.inputCostUsd.toFixed(6),
        payload.outputCostUsd.toFixed(6),
        payload.promptTokens,
        payload.completionTokens,
        payload.totalTokens,
        payload.status,
        payload.errorCode ?? null,
        payload.durationMs,
        JSON.stringify(payload.metadata ?? {}),
      ],
    );

    const publicId = rows[0]?.public_id ?? null;

    console.log(
      `[TxLog] ✓ txn logged | id=${publicId} | ` +
      `${payload.provider}:${payload.model} | ` +
      `cost=$${payload.costUsd.toFixed(6)} | ` +
      `${payload.durationMs}ms`
    );

    return publicId;

  } catch (err: any) {
    // Fail-open: log the error but never reject
    console.error('[TxLog] Failed to write transaction row:', err.message);
    return null;
  }
}
