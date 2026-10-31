/** Shape of a transaction event published to the `transactions` Kafka topic.
 *  Mirrors the Postgres `transactions` row from Phase 3 (the gateway emits one
 *  per API call). Extra/unknown fields are ignored by the consumer. */
export interface TransactionEvent {
  organization_id?: number | string;
  workspace_id?: number | string;
  virtual_key_id?: number | string;
  user_id?: number | string;
  actor?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
  request_id?: string;
  cost_center?: string;
  project_tag?: string | null;
  currency?: string;
  cost_usd?: number;
  amortized_cost_usd?: number;
  input_cost_usd?: number;
  output_cost_usd?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  status?: string;
  error_code?: string | null;
  shadow_ai_flag?: boolean;
  duration_ms?: number;
  metadata?: Record<string, unknown> | string;
  created_at?: string; // ISO-8601; if absent, ClickHouse defaults to now()
}

/** Row written to the ClickHouse `transactions_raw` table. */
export interface RawTransactionRow {
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
