import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getProviderBreakdown } from "@/lib/mock-data";
import { getSessionFromRequest, unauthorizedResponse } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const url = new URL(req.url);
  const period = url.searchParams.get("period") || "month";

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      period,
      total_spend_usd: 0,
      total_requests: 0,
      avg_latency_ms: 0,
      top_provider: "none",
      breakdown: [],
    });
  }

  try {
    const pool = getPool();
    let timeFilter = "date_trunc('month', now())";
    if (period === "today") timeFilter = "date_trunc('day', now())";
    if (period === "week") timeFilter = "now() - interval '7 days'";

    const orgId = session.orgId;

    const [sumRes, countRes, provRes] = await Promise.all([
      pool.query<{ total: string }>(`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM transactions
        WHERE organization_id = $1 AND status = 'success' AND created_at >= ${timeFilter}
      `, [orgId]),
      pool.query<{ count: string; avg_lat: string }>(`
        SELECT COUNT(*)::text AS count, COALESCE(AVG(duration_ms), 0)::text AS avg_lat
        FROM transactions
        WHERE organization_id = $1 AND status = 'success' AND created_at >= ${timeFilter}
      `, [orgId]),
      pool.query<{ provider: string; spend: string }>(`
        SELECT provider, SUM(cost_usd)::text AS spend
        FROM transactions
        WHERE organization_id = $1 AND status = 'success' AND created_at >= ${timeFilter}
        GROUP BY provider
        ORDER BY SUM(cost_usd) DESC
      `, [orgId]),
    ]);

    const totalSpend = parseFloat(sumRes.rows[0]?.total || "0");
    const totalRequests = parseInt(countRes.rows[0]?.count || "0", 10);
    const avgLatencyMs = parseFloat(countRes.rows[0]?.avg_lat || "0");

    return NextResponse.json({
      period,
      total_spend_usd: totalSpend,
      total_requests: totalRequests,
      avg_latency_ms: Math.round(avgLatencyMs),
      top_provider: provRes.rows[0]?.provider || "none",
      breakdown: provRes.rows.map((r) => ({
        provider: r.provider,
        spend_usd: parseFloat(r.spend),
      })),
    });
  } catch (err: any) {
    console.error("[/api/summary] DB error, falling back:", err.message);
    return NextResponse.json({
      period,
      total_spend_usd: 0,
      total_requests: 0,
      avg_latency_ms: 0,
      top_provider: "none",
      breakdown: [],
    });
  }
}
