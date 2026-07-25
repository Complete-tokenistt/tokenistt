/**
 * GET /api/anomalies
 *
 * Anomaly detection: returns actors whose spend in the last 24 hours
 * is >= 3× their average daily spend over the past 30 days.
 *
 * SQL strategy:
 *   1. Calculate 30-day daily average per actor (SUM / 30).
 *   2. Calculate 24-hour spend per actor.
 *   3. JOIN and filter where ratio >= 3.
 *   4. Classify severity: ratio >= 5 → high, >= 3 → medium.
 *
 * Falls back to mock data when DATABASE_URL is not configured.
 */

import { NextResponse }  from 'next/server';
import { getPool }       from '@/lib/db';
import { getAnomalies }  from '@/lib/mock-data';
import type { AnomalySeverity } from '@/lib/types';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const ratioThreshold  = parseFloat(searchParams.get('ratio') ?? '3');

  // ── Fallback: no DB ────────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(getAnomalies());
  }

  try {
    const pool = getPool();

    const { rows } = await pool.query<{
      actor:           string;
      cost_center:     string;
      spend_24h:       string;
      avg_daily_30d:   string;
      ratio:           string;
      latest_at:       string;
    }>(`
      WITH spend_30d AS (
        SELECT actor,
               MAX(cost_center)          AS cost_center,
               SUM(cost_usd) / 30.0      AS avg_daily
        FROM   transactions
        WHERE  status     = 'success'
          AND  created_at >= now() - interval '30 days'
          AND  actor IS NOT NULL
        GROUP  BY actor
      ),
      spend_24h AS (
        SELECT actor,
               SUM(cost_usd)   AS total,
               MAX(created_at) AS latest_at
        FROM   transactions
        WHERE  status     = 'success'
          AND  created_at >= now() - interval '24 hours'
          AND  actor IS NOT NULL
        GROUP  BY actor
      )
      SELECT
        s24.actor,
        s30.cost_center,
        s24.total::text                           AS spend_24h,
        s30.avg_daily::text                       AS avg_daily_30d,
        (s24.total / NULLIF(s30.avg_daily, 0))::text AS ratio,
        s24.latest_at::text                       AS latest_at
      FROM   spend_24h  s24
      JOIN   spend_30d  s30 USING (actor)
      WHERE  s30.avg_daily > 0
        AND  s24.total / s30.avg_daily >= $1
      ORDER  BY (s24.total / s30.avg_daily) DESC
      LIMIT  50
    `, [ratioThreshold]);

    const anomalies = rows.map((r, i) => {
      const ratio: number = parseFloat(r.ratio);
      const severity: AnomalySeverity =
        ratio >= 5 ? 'high' : ratio >= 3 ? 'medium' : 'low';

      return {
        id:              `an-${i + 1}`,
        actor:           r.actor,
        costCenter:      r.cost_center ?? 'unknown',
        spend24hUsd:     parseFloat(r.spend_24h),
        avgDaily30dUsd:  parseFloat(r.avg_daily_30d),
        ratio:           parseFloat(ratio.toFixed(2)),
        severity,
        detectedAt:      r.latest_at,
      };
    });

    return NextResponse.json(anomalies.length ? anomalies : [], {
      headers: { 'x-source': 'postgres' },
    });
  } catch (err: any) {
    console.error('[/api/anomalies] DB error, falling back to mock:', err.message);
    return NextResponse.json(getAnomalies());
  }
}
