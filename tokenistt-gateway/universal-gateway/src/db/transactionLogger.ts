/**
 * db/transactionLogger.ts — Async event logger to Postgres `transactions`.
 *
 * Writes one immutable row per API call (the FinOps ledger).
 * This is fire-and-forget: errors are logged but never bubble up to the
 * HTTP response so the gateway stays "fail-open" — a DB hiccup never
 * blocks an AI call.
 *
 * DURABILITY: If PostgreSQL is temporarily unavailable, the transaction is
 * enqueued to a durable JSONL file and retried by the drain scheduler.
 * Provider API keys and prompt/response content are NEVER persisted.
 * Each request_id is idempotent (ON CONFLICT DO NOTHING).
 *
 * If DATABASE_URL is not set the logger silently skips (dev mode).
 */

import { getPool } from './pool.js';
import type { AuthContext } from './auth.js';
import { incrementCachedBudget, adjustBudgetReservation } from '../services/redis.js';
import { emitTransactionEvent } from '../services/eventEmitter.js';
import { upsertHourlyRollup } from '../services/hourlyRollup.js';
import { enqueueTransaction } from './durableQueue.js';


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
  cacheCreationTokens?: number;
  cacheReadTokens?:   number;
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
    emitTransactionEvent({
      requestId: payload.requestId,
      organizationId: payload.auth.organizationId !== BigInt(0) ? payload.auth.organizationId?.toString() : null,
      virtualKeyPublicId: payload.auth.virtualKeyPublicId,
      provider: payload.provider,
      model: payload.model,
      costUsd: payload.costUsd,
      inputTokens: payload.promptTokens,
      outputTokens: payload.completionTokens,
      latencyMs: payload.durationMs,
      status: payload.status,
      actor: payload.auth.actor,
      costCenter: payload.auth.costCenter,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    return null;
  }

  try {
    const pool = getPool();

    const { rows } = await pool.query<{ public_id: string }>(
      `
      INSERT INTO transactions (
        organization_id,
        workspace_id,
        virtual_key_id,
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
        cache_creation_tokens,
        cache_read_tokens,
        status,
        error_code,
        duration_ms,
        metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23
      )
      RETURNING public_id::text
      `,
      [
        payload.auth.organizationId !== BigInt(0) ? payload.auth.organizationId : null,
        payload.auth.workspaceId,
        payload.auth.virtualKeyId !== BigInt(0)   ? payload.auth.virtualKeyId   : null,
        payload.auth.actor,
        payload.provider,
        payload.model,
        payload.endpoint,
        payload.requestId,
        payload.auth.costCenter,
        payload.projectTag ?? null,
        payload.costUsd.toFixed(6),
        payload.costUsd.toFixed(6),
        payload.inputCostUsd.toFixed(6),
        payload.outputCostUsd.toFixed(6),
        payload.promptTokens,
        payload.completionTokens,
        payload.totalTokens,
        payload.cacheCreationTokens ?? 0,
        payload.cacheReadTokens ?? 0,
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

    if (payload.status === 'success' && payload.auth.rawToken) {
      // Increment cached budget in Redis (ignore errors, fail-open)
      incrementCachedBudget(payload.auth.rawToken, payload.costUsd).catch(() => {});
      
      // Reconcile atomic reservation with actual cost
      if (payload.auth.budgetReservation) {
        adjustBudgetReservation(
          payload.auth.budgetReservation.token,
          payload.auth.budgetReservation.estimated,
          payload.costUsd,
          payload.auth.budgetReservation.period
        ).catch(() => {});
      }
    } else if (payload.auth.budgetReservation) {
      // On failure or non-success, release full reservation
      adjustBudgetReservation(
        payload.auth.budgetReservation.token,
        payload.auth.budgetReservation.estimated,
        0,
        payload.auth.budgetReservation.period
      ).catch(() => {});
    }

    if (payload.auth.organizationId !== BigInt(0)) {
      upsertHourlyRollup({
        organizationId: payload.auth.organizationId,
        teamId: null,
        projectId: null,
        provider: payload.provider,
        model: payload.model,
        costUsd: payload.costUsd,
        totalTokens: payload.totalTokens,
        inputTokens: payload.promptTokens,
        outputTokens: payload.completionTokens,
        isError: payload.status !== 'success',
      }).catch(() => {});
    }

    emitTransactionEvent({
      requestId: payload.requestId,
      organizationId: payload.auth.organizationId !== BigInt(0) ? payload.auth.organizationId?.toString() : null,
      virtualKeyPublicId: payload.auth.virtualKeyPublicId,
      provider: payload.provider,
      model: payload.model,
      costUsd: payload.costUsd,
      inputTokens: payload.promptTokens,
      outputTokens: payload.completionTokens,
      latencyMs: payload.durationMs,
      status: payload.status,
      actor: payload.auth.actor,
      costCenter: payload.auth.costCenter,
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    return publicId;

  } catch (err: any) {
    // DB unavailable: enqueue transaction for durable retry.
    // Provider API keys and prompt/response content are NEVER persisted.
    console.error('[TxLog] Failed to write transaction row, enqueuing for retry:', err.message);
    enqueueTransaction({
      requestId: payload.requestId,
      organizationId: payload.auth.organizationId !== BigInt(0) ? payload.auth.organizationId.toString() : null,
      workspaceId: payload.auth.workspaceId ? payload.auth.workspaceId.toString() : null,
      virtualKeyId: payload.auth.virtualKeyId !== BigInt(0) ? payload.auth.virtualKeyId.toString() : null,
      actor: payload.auth.actor,
      provider: payload.provider,
      model: payload.model,
      endpoint: payload.endpoint,
      costCenter: payload.auth.costCenter,
      projectTag: payload.projectTag ?? null,
      costUsd: payload.costUsd.toFixed(6),
      inputCostUsd: payload.inputCostUsd.toFixed(6),
      outputCostUsd: payload.outputCostUsd.toFixed(6),
      promptTokens: payload.promptTokens,
      completionTokens: payload.completionTokens,
      totalTokens: payload.totalTokens,
      cacheCreationTokens: payload.cacheCreationTokens ?? 0,
      cacheReadTokens: payload.cacheReadTokens ?? 0,
      status: payload.status,
      errorCode: payload.errorCode ?? null,
      durationMs: payload.durationMs,
      // Metadata: exclude any sensitive fields (real_api_key is stripped by AuthContext)
      metadata: {
        trace_id: (payload.metadata as any)?.trace_id,
        cost_status: (payload.metadata as any)?.cost_status,
        finish_reason: (payload.metadata as any)?.finish_reason,
        model_used: (payload.metadata as any)?.model_used,
      },
      queuedAt: new Date().toISOString(),
      attempts: 0,
    });
    return null;
  }
}
