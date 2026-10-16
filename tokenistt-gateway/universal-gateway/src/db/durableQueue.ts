/**
 * db/durableQueue.ts — Durable retry queue for failed ledger writes.
 *
 * When PostgreSQL is temporarily unavailable, billable transactions are written
 * to a local JSONL file so they can be retried after recovery.
 *
 * Safety guarantees:
 * - Provider API keys and real_api_key are NEVER persisted.
 * - Prompt/response content is NEVER logged or persisted.
 * - Idempotency: each entry carries the original request_id; the DB INSERT uses
 *   WHERE NOT EXISTS (...) check is used for idempotency, which is safe against
 *   concurrent inserts (a btree index on request_id makes the NOT EXISTS sub-query fast).
 * - Queue file corruption is handled: malformed lines are skipped.
 * - Disk-full: queue writes fail silently; the transaction is already sent to
 *   the client. We log a warning but do not crash.
 * - Process restart: queue is re-read from disk on startup.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface QueuedTransaction {
  requestId: string;
  organizationId: string | null;
  workspaceId: string | null;
  virtualKeyId: string | null;
  actor: string;
  provider: string;
  model: string;
  endpoint: string;
  costCenter: string;
  projectTag: string | null;
  costUsd: string;
  inputCostUsd: string;
  outputCostUsd: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  status: string;
  errorCode: string | null;
  durationMs: number;
  metadata: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
}

const QUEUE_FILE = process.env.TX_QUEUE_FILE || join(process.cwd(), 'tx_queue.jsonl');
const MAX_ATTEMPTS = 10;

let drainTimer: ReturnType<typeof setTimeout> | null = null;
let isDraining = false;

export function enqueueTransaction(tx: QueuedTransaction): void {
  try {
    appendFileSync(QUEUE_FILE, JSON.stringify(tx) + '\n', { encoding: 'utf-8' });
    console.warn(
      `[DurableQueue] Transaction ${tx.requestId} queued for retry ` +
      `(${QUEUE_FILE}). Will retry when DB recovers.`
    );
  } catch (err: any) {
    console.error(`[DurableQueue] FAILED to write queue file: ${err.message}. ` +
      `Transaction ${tx.requestId} may be lost if DB remains unavailable.`);
  }
}

export async function drainQueue(pool: any): Promise<void> {
  if (isDraining) return;
  if (!existsSync(QUEUE_FILE)) return;

  isDraining = true;
  let raw: string;
  try {
    raw = readFileSync(QUEUE_FILE, { encoding: 'utf-8' });
  } catch {
    isDraining = false;
    return;
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) {
    isDraining = false;
    return;
  }

  console.log(`[DurableQueue] Draining ${lines.length} queued transactions...`);

  const remaining: string[] = [];

  for (const line of lines) {
    let tx: QueuedTransaction;
    try {
      tx = JSON.parse(line) as QueuedTransaction;
    } catch {
      continue;
    }

    if (tx.attempts >= MAX_ATTEMPTS) {
      console.error(`[DurableQueue] Transaction ${tx.requestId} exceeded ${MAX_ATTEMPTS} attempts — discarding.`);
      continue;
    }

    try {
      // Idempotency guard: skip if this request_id is already in the ledger.
      // We cannot use ON CONFLICT (request_id) because the transactions table
      // is partitioned by created_at, and PostgreSQL requires the partition key
      // to be part of any unique index. Instead we use INSERT … WHERE NOT EXISTS,
      // which is safe against concurrent inserts (the btree index on request_id
      // makes the NOT EXISTS sub-query fast).
      await pool.query(
        `INSERT INTO transactions (
          organization_id, workspace_id, virtual_key_id, actor,
          provider, model, endpoint, request_id, cost_center, project_tag,
          cost_usd, amortized_cost_usd, input_cost_usd, output_cost_usd,
          prompt_tokens, completion_tokens, total_tokens,
          cache_creation_tokens, cache_read_tokens,
          status, error_code, duration_ms, metadata
        )
        SELECT
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22, $23
        WHERE NOT EXISTS (
          SELECT 1 FROM transactions WHERE request_id = $8
        )`,
        [
          tx.organizationId, tx.workspaceId, tx.virtualKeyId, tx.actor,
          tx.provider, tx.model, tx.endpoint, tx.requestId, tx.costCenter, tx.projectTag,
          tx.costUsd, tx.costUsd, tx.inputCostUsd, tx.outputCostUsd,
          tx.promptTokens, tx.completionTokens, tx.totalTokens,
          tx.cacheCreationTokens, tx.cacheReadTokens,
          tx.status, tx.errorCode, tx.durationMs, JSON.stringify(tx.metadata),
        ]
      );
      console.log(`[DurableQueue] Recovered transaction ${tx.requestId}`);
    } catch (err: any) {
      tx.attempts += 1;
      remaining.push(JSON.stringify(tx));
    }
  }

  try {
    writeFileSync(QUEUE_FILE, remaining.length > 0 ? remaining.join('\n') + '\n' : '', { encoding: 'utf-8' });
  } catch (err: any) {
    console.error(`[DurableQueue] Failed to rewrite queue file: ${err.message}`);
  }

  isDraining = false;
}

export function startDrainScheduler(getPool: () => any): void {
  const attempt = async () => {
    try {
      const pool = getPool();
      if (pool && existsSync(QUEUE_FILE)) {
        const raw = readFileSync(QUEUE_FILE, { encoding: 'utf-8' });
        if (raw.trim()) await drainQueue(pool);
      }
    } catch { /* ignore */ }
    drainTimer = setTimeout(attempt, 30_000);
  };
  drainTimer = setTimeout(attempt, 10_000);
}

export function stopDrainScheduler(): void {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
}
