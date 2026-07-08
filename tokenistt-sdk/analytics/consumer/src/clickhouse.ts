import { createClient, ClickHouseClient } from '@clickhouse/client';
import { config } from './config.js';
import type { RawTransactionRow, TransactionEvent } from './types.js';

export const clickhouse: ClickHouseClient = createClient({
  url: config.clickhouse.url,
  username: config.clickhouse.user,
  password: config.clickhouse.password,
  database: config.clickhouse.database,
  request_timeout: 60_000,
  keep_alive: { enabled: true },
});

/** Map a Kafka event into a ClickHouse row, coercing types defensively. */
export function toRow(e: TransactionEvent): RawTransactionRow {
  const num = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    organization_id: num(e.organization_id),
    workspace_id: e.workspace_id != null ? num(e.workspace_id) : 0,
    virtual_key_id: e.virtual_key_id != null ? num(e.virtual_key_id) : 0,
    user_id: e.user_id != null ? num(e.user_id) : 0,
    actor: e.actor ?? '',
    provider: e.provider ?? '',
    model: e.model ?? '',
    endpoint: e.endpoint ?? '/chat/completions',
    request_id: e.request_id ?? '',
    cost_center: e.cost_center ?? '',
    project_tag: e.project_tag ?? '',
    currency: e.currency ?? 'USD',
    cost_usd: num(e.cost_usd),
    amortized_cost_usd: num(e.amortized_cost_usd),
    input_cost_usd: num(e.input_cost_usd),
    output_cost_usd: num(e.output_cost_usd),
    prompt_tokens: num(e.prompt_tokens),
    completion_tokens: num(e.completion_tokens),
    total_tokens: num(e.total_tokens),
    cache_creation_tokens: num(e.cache_creation_tokens),
    cache_read_tokens: num(e.cache_read_tokens),
    status: e.status ?? 'success',
    error_code: e.error_code ?? '',
    shadow_ai_flag: e.shadow_ai_flag ? 1 : 0,
    duration_ms: num(e.duration_ms),
    metadata:
      typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata ?? {}),
    created_at: e.created_at, // omitted -> ClickHouse uses DEFAULT now64(6)
  };
}

/** Bulk insert a batch of raw rows. */
export async function insertTransactions(rows: RawTransactionRow[]): Promise<void> {
  if (rows.length === 0) return;
  await clickhouse.insert({
    table: 'transactions_raw',
    values: rows,
    format: 'JSONEachRow',
  });
}

/** Persist currently-flagged anomalies into `spend_anomalies`. */
export async function persistAnomalies(): Promise<void> {
  const query = `
    INSERT INTO spend_anomalies
      (organization_id, actor, window_start, window_end, spend_window, avg_daily_30d, ratio, severity)
    SELECT
      organization_id,
      actor,
      now() - INTERVAL 24 HOUR,
      now(),
      spend_24h,
      avg_daily_30d,
      ratio,
      multiIf(ratio > 10, 'critical', ratio > 5, 'high', 'medium')
    FROM v_user_anomalies
  `;
  await clickhouse.command({ query });
}
