/**
 * services/clickhouse.ts — ClickHouse Dual-Write Adapter & Analytics Activation Path
 *
 * FINOPS ARCHITECTURAL CONSTRAINT:
 *  - Tokenistt adheres to a strict "Postgres-First" architecture. PostgreSQL is the
 *    authoritative source of truth for transactions, billing, keys, and budgets.
 *  - ClickHouse dual-write is DISABLED BY DEFAULT (CLICKHOUSE_ENABLED=false).
 *  - Activate ClickHouse only when PostgreSQL transaction table volume exceeds 5M+ rows
 *    or when extreme real-time OLAP aggregation throughput is required.
 *
 * ACTIVATION RUNBOOK (When scaling beyond 5M transactions):
 *  1. Start ClickHouse cluster:
 *     $ cd tokenistt-sdk/analytics && docker compose up -d clickhouse
 *  2. Verify ClickHouse schema is initialized from clickhouse/init/01_schema.sql.
 *  3. Set environment variables in .env:
 *     CLICKHOUSE_ENABLED=true
 *     CLICKHOUSE_URL=http://localhost:8123 (or http://clickhouse:8123 in docker network)
 *     CLICKHOUSE_USER=default
 *     CLICKHOUSE_PASSWORD=
 *     CLICKHOUSE_DATABASE=default
 *  4. Restart Gateway: Dual-write begins asynchronously with buffered batches.
 *     Postgres remains the authoritative ledger; ClickHouse accelerates analytics & Grafana.
 */

import axios from 'axios';
import type { TransactionEvent } from './eventEmitter.js';

export interface ClickHouseConfig {
  enabled: boolean;
  url: string;
  user?: string;
  password?: string;
  database: string;
  batchSize: number;
  flushIntervalMs: number;
}

export function getClickHouseConfig(): ClickHouseConfig {
  return {
    enabled: process.env.CLICKHOUSE_ENABLED === 'true',
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'default',
    batchSize: parseInt(process.env.CLICKHOUSE_BATCH_SIZE || '100', 10),
    flushIntervalMs: parseInt(process.env.CLICKHOUSE_FLUSH_INTERVAL_MS || '2000', 10),
  };
}

export interface ClickHouseTransactionRow {
  organization_id: number;
  workspace_id: number;
  virtual_key_id: number;
  user_id: number;
  actor: string;
  provider: string;
  model: string;
  endpoint: string;
  request_id: string;
  cost_center: string;
  project_tag: string;
  currency: string;
  cost_usd: number;
  amortized_cost_usd: number;
  input_cost_usd: number;
  output_cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  status: string;
  error_code: string;
  shadow_ai_flag: number;
  duration_ms: number;
  metadata: string;
  created_at?: string;
}

/**
 * Transforms a generic TransactionEvent into a typed ClickHouse row matching `transactions_raw` schema.
 */
export function formatClickHouseRow(event: TransactionEvent): ClickHouseTransactionRow {
  const num = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    organization_id: num(event.organizationId),
    workspace_id: 0,
    virtual_key_id: 0,
    user_id: 0,
    actor: event.actor || '',
    provider: event.provider || '',
    model: event.model || '',
    endpoint: '/v1/chat/completions',
    request_id: event.requestId || '',
    cost_center: event.costCenter || 'default',
    project_tag: '',
    currency: 'USD',
    cost_usd: num(event.costUsd),
    amortized_cost_usd: num(event.costUsd),
    input_cost_usd: 0,
    output_cost_usd: 0,
    prompt_tokens: num(event.inputTokens),
    completion_tokens: num(event.outputTokens),
    total_tokens: num(event.inputTokens) + num(event.outputTokens),
    cache_creation_tokens: 0,
    cache_read_tokens: num(event.cachedTokens),
    status: event.status || 'success',
    error_code: '',
    shadow_ai_flag: 0,
    duration_ms: num(event.latencyMs),
    metadata: JSON.stringify({
      cost_status: event.costStatus || 'ok',
      virtualKeyPublicId: event.virtualKeyPublicId,
      teamId: event.teamId,
      projectId: event.projectId,
    }),
    created_at: event.timestamp || new Date().toISOString(),
  };
}

let batchBuffer: ClickHouseTransactionRow[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let isFlushing = false;

/**
 * Queues an event for asynchronous ClickHouse dual-write.
 * If ClickHouse is disabled, this is an immediate no-op.
 * Always fails open: errors are logged and never throw.
 */
export async function forwardToClickHouse(event: TransactionEvent): Promise<void> {
  const config = getClickHouseConfig();
  if (!config.enabled) {
    return;
  }

  try {
    const row = formatClickHouseRow(event);
    batchBuffer.push(row);

    if (batchBuffer.length >= config.batchSize) {
      await flushClickHouseBuffer();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushClickHouseBuffer().catch(() => {});
      }, config.flushIntervalMs);

      if (flushTimer.unref) flushTimer.unref();
    }
  } catch (err: any) {
    console.warn('[ClickHouse] Buffer queue error (fail-open):', err.message);
  }
}

/**
 * Flushes buffered transaction rows to ClickHouse HTTP endpoint using JSONEachRow format.
 */
export async function flushClickHouseBuffer(): Promise<number> {
  const config = getClickHouseConfig();
  if (!config.enabled || batchBuffer.length === 0 || isFlushing) {
    return 0;
  }

  isFlushing = true;
  const rowsToSend = [...batchBuffer];
  batchBuffer = [];

  try {
    const body = rowsToSend.map((r) => JSON.stringify(r)).join('\n');
    const url = `${config.url.replace(/\/$/, '')}/?query=${encodeURIComponent(
      `INSERT INTO ${config.database}.transactions_raw FORMAT JSONEachRow`
    )}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.user) {
      headers['X-ClickHouse-User'] = config.user;
    }
    if (config.password) {
      headers['X-ClickHouse-Key'] = config.password;
    }

    await axios.post(url, body, {
      headers,
      timeout: 5000,
    });

    return rowsToSend.length;
  } catch (err: any) {
    // Re-queue rows if buffer hasn't grown too large (max 1000 items safety cap)
    if (batchBuffer.length < 1000) {
      batchBuffer = [...rowsToSend, ...batchBuffer];
    }
    console.warn(`[ClickHouse] Dual-write flush failed (${rowsToSend.length} rows dropped/re-queued):`, err.message);
    return 0;
  } finally {
    isFlushing = false;
  }
}

/**
 * Health check to verify ClickHouse HTTP endpoint reachability and readiness.
 */
export async function checkClickHouseHealth(): Promise<{ enabled: boolean; reachable: boolean; error?: string }> {
  const config = getClickHouseConfig();
  if (!config.enabled) {
    return { enabled: false, reachable: false };
  }

  try {
    const pingUrl = `${config.url.replace(/\/$/, '')}/ping`;
    const res = await axios.get(pingUrl, { timeout: 3000 });
    return { enabled: true, reachable: res.status === 200 };
  } catch (err: any) {
    return { enabled: true, reachable: false, error: err.message };
  }
}

/**
 * For testing / cleanup: get buffer count and clear buffer.
 */
export function getBufferCount(): number {
  return batchBuffer.length;
}

export function clearBuffer(): void {
  batchBuffer = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

