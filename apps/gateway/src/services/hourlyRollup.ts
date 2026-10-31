/**
 * services/hourlyRollup.ts — Materialized hourly aggregation rollups.
 *
 * Provides sub-millisecond aggregations for Cost Explorer, real-time metrics,
 * forecasting, and anomaly detection without performing table scans across transactions.
 */

import { getPool } from '../db/pool.js';

export interface HourlyRollupInput {
  organizationId: bigint;
  teamId?: bigint | null;
  projectId?: bigint | null;
  provider: string;
  model: string;
  costUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  isError: boolean;
}

/**
 * Upserts a transaction metrics event into `hourly_spend`.
 * Safe and fail-open: skips if DATABASE_URL is not set or if an error occurs.
 */
export async function upsertHourlyRollup(input: HourlyRollupInput): Promise<void> {
  if (!process.env.DATABASE_URL || input.organizationId === BigInt(0)) {
    return;
  }

  const hourBucket = new Date();
  hourBucket.setMinutes(0, 0, 0);

  try {
    const pool = getPool();
    await pool.query(
      `
      INSERT INTO hourly_spend (
        organization_id,
        team_id,
        project_id,
        provider,
        model,
        hour_bucket,
        request_count,
        total_tokens,
        input_tokens,
        output_tokens,
        cost_usd,
        error_count
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        1, $7, $8, $9, $10, $11
      )
      ON CONFLICT (organization_id, provider, model, hour_bucket)
      DO UPDATE SET
        request_count = hourly_spend.request_count + 1,
        total_tokens  = hourly_spend.total_tokens  + EXCLUDED.total_tokens,
        input_tokens  = hourly_spend.input_tokens  + EXCLUDED.input_tokens,
        output_tokens = hourly_spend.output_tokens + EXCLUDED.output_tokens,
        cost_usd      = hourly_spend.cost_usd      + EXCLUDED.cost_usd,
        error_count   = hourly_spend.error_count   + EXCLUDED.error_count
      `,
      [
        input.organizationId,
        input.teamId ?? null,
        input.projectId ?? null,
        input.provider,
        input.model,
        hourBucket.toISOString(),
        input.totalTokens,
        input.inputTokens,
        input.outputTokens,
        input.costUsd.toFixed(6),
        input.isError ? 1 : 0,
      ]
    );
  } catch (err: any) {
    // Non-blocking: fail-open so API calls are never rejected by rollup failures
    console.warn('[HourlyRollup] Failed to upsert rollup:', err.message);
  }
}

