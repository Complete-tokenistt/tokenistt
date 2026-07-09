/**
 * GET /api/providers
 *
 * Returns the spend breakdown by provider for the current calendar month:
 *   - provider: provider key (openai, anthropic, bedrock, etc.)
 *   - label: formatted provider name
 *   - spendUsd: total cost_usd for this provider
 *   - sharePct: percentage of total spend
 *   - color: hex color code for visualization
 *
 * Falls back to mock data when DATABASE_URL is not configured.
 */

import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getProviderBreakdown } from "@/lib/mock-data";
import { PROVIDER_COLORS, PROVIDER_LABELS } from "@/lib/format";
import type { Provider } from "@/lib/types";

export async function GET() {
  // ── Fallback: no DB ────────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(await getProviderBreakdown());
  }

  try {
    const pool = getPool();

    const [totalRes, spendRes] = await Promise.all([
      // 1. Total spend for percentage calculation
      pool.query<{ total: string }>(`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM   transactions
        WHERE  status = 'success'
          AND  created_at >= date_trunc('month', now())
      `),
      // 2. Spend grouped by provider
      pool.query<{ provider: string; spend: string }>(`
        SELECT provider,
               SUM(cost_usd)::text AS spend
        FROM   transactions
        WHERE  status = 'success'
          AND  created_at >= date_trunc('month', now())
        GROUP  BY provider
        ORDER  BY SUM(cost_usd) DESC
      `),
    ]);

    const totalSpend = parseFloat(totalRes.rows[0].total || "0");

    const rows = spendRes.rows.map((r) => {
      const providerKey = r.provider.toLowerCase() as Provider;
      const spendUsd = parseFloat(r.spend);
      const sharePct = totalSpend > 0 ? (spendUsd / totalSpend) * 100 : 0;

      return {
        provider: providerKey,
        label: PROVIDER_LABELS[providerKey] ?? r.provider,
        spendUsd,
        sharePct,
        color: PROVIDER_COLORS[providerKey] ?? PROVIDER_COLORS.other,
      };
    });

    return NextResponse.json(rows);
  } catch (err: any) {
    console.error("[/api/providers] DB error, falling back to mock:", err.message);
    return NextResponse.json(await getProviderBreakdown());
  }
}
