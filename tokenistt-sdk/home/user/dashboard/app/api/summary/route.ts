/**
 * GET /api/summary
 *
 * Returns executive-level KPIs for the current calendar month:
 *   - totalSpendUsd      — SUM(cost_usd) from transactions this month
 *   - momGrowthPct       — vs previous calendar month
 *   - topCostCenters     — top 3 cost_center groups by spend
 *   - anomalyCount       — actors whose 24h spend > 3× their 30-day daily avg
 *   - dailySpendUsd      — today's spend (for the live feed card)
 *
 * Falls back to mock data when DATABASE_URL is not configured.
 */

import { NextResponse } from 'next/server';
import { getPool }      from '@/lib/db';
import { getSummary }   from '@/lib/mock-data';
import { PROVIDER_COLORS, PROVIDER_LABELS } from '@/lib/format';

const BUDGET_USD = parseFloat(process.env.MONTHLY_BUDGET_USD ?? '25000');

export async function GET() {
  // ── Fallback: no DB ────────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(await getSummary());
  }

  try {
    const pool = getPool();

    // Run all queries in parallel for speed
    const [spendRes, prevRes, topRes, anomalyRes, todayRes, shadowRes] =
      await Promise.all([
        // 1. Current month total
        pool.query<{ total: string }>(`
          SELECT COALESCE(SUM(cost_usd), 0)::text AS total
          FROM   transactions
          WHERE  status     = 'success'
            AND  created_at >= date_trunc('month', now())
        `),

        // 2. Previous month total (for MoM growth)
        pool.query<{ total: string }>(`
          SELECT COALESCE(SUM(cost_usd), 0)::text AS total
          FROM   transactions
          WHERE  status     = 'success'
            AND  created_at >= date_trunc('month', now()) - interval '1 month'
            AND  created_at <  date_trunc('month', now())
        `),

        // 3. Top 3 cost centers this month
        pool.query<{ cost_center: string; spend: string }>(`
          SELECT cost_center,
                 SUM(cost_usd)::text AS spend
          FROM   transactions
          WHERE  status     = 'success'
            AND  created_at >= date_trunc('month', now())
          GROUP  BY cost_center
          ORDER  BY SUM(cost_usd) DESC
          LIMIT  3
        `),

        // 4. Anomaly count: actors whose 24h spend > 3× their 30d daily avg
        pool.query<{ cnt: string }>(`
          WITH daily_avg AS (
            SELECT actor,
                   SUM(cost_usd) / 30.0 AS avg_daily
            FROM   transactions
            WHERE  status     = 'success'
              AND  created_at >= now() - interval '30 days'
            GROUP  BY actor
          ),
          spend_24h AS (
            SELECT actor,
                   SUM(cost_usd) AS spend
            FROM   transactions
            WHERE  status     = 'success'
              AND  created_at >= now() - interval '24 hours'
            GROUP  BY actor
          )
          SELECT COUNT(*)::text AS cnt
          FROM   spend_24h s
          JOIN   daily_avg d USING (actor)
          WHERE  s.spend > d.avg_daily * 3
        `),

        // 5. Today's spend
        pool.query<{ total: string }>(`
          SELECT COALESCE(SUM(cost_usd), 0)::text AS total
          FROM   transactions
          WHERE  status     = 'success'
            AND  created_at >= date_trunc('day', now())
        `),

        // 6. Shadow AI spend this month (flagged transactions)
        pool.query<{ total: string; cnt: string }>(`
          SELECT COALESCE(SUM(cost_usd), 0)::text AS total,
                 COUNT(*)::text                    AS cnt
          FROM   transactions
          WHERE  shadow_ai_flag = true
            AND  created_at >= date_trunc('month', now())
        `),
      ]);

    const totalSpendUsd   = parseFloat(spendRes.rows[0].total);
    const prevMonthSpend  = parseFloat(prevRes.rows[0].total);
    const momGrowthPct    =
      prevMonthSpend > 0
        ? ((totalSpendUsd - prevMonthSpend) / prevMonthSpend) * 100
        : 0;

    const topCostCenters = topRes.rows.map((r) => ({
      name:      r.cost_center,
      code:      r.cost_center,
      spendUsd:  parseFloat(r.spend),
      sharePct:  totalSpendUsd > 0 ? (parseFloat(r.spend) / totalSpendUsd) * 100 : 0,
    }));

    return NextResponse.json({
      month:            new Date().toISOString().slice(0, 7),
      monthLabel:       new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      totalSpendUsd,
      budgetUsd:        BUDGET_USD,
      budgetUsedPct:    (totalSpendUsd / BUDGET_USD) * 100,
      momGrowthPct,
      topCostCenters,
      anomalyCount:     parseInt(anomalyRes.rows[0].cnt, 10),
      dailySpendUsd:    parseFloat(todayRes.rows[0].total),
      shadowAiSpendUsd: parseFloat(shadowRes.rows[0].total),
      shadowAiCount:    parseInt(shadowRes.rows[0].cnt, 10),
      _source:          'postgres',
    });
  } catch (err: any) {
    console.error('[/api/summary] DB error, falling back to mock:', err.message);
    return NextResponse.json({ ...getSummary(), _source: 'mock_fallback' });
  }
}
