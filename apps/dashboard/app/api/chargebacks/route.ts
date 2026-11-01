import { NextRequest, NextResponse } from "next/server";
import { getPool, isDbAvailable } from "@/lib/db";
import { getSessionFromRequest, unauthorizedResponse } from "@/lib/auth";
import { dbUnavailable } from "@/lib/db-unavailable";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const searchParams = req.nextUrl.searchParams;
  const period = searchParams.get("period") || "month";

  const dbUp = await isDbAvailable();
  if (!dbUp) return dbUnavailable();

  try {
    const pool = getPool();
    let timeFilter = "date_trunc('month', now())";
    if (period === "quarter") timeFilter = "date_trunc('quarter', now())";
    if (period === "year") timeFilter = "date_trunc('year', now())";

    const { rows } = await pool.query<{
      cost_center: string;
      spend_usd: string;
      request_count: string;
      active_actors: string;
    }>(
      `
      SELECT 
        COALESCE(t.cost_center, 'default') AS cost_center,
        COALESCE(SUM(t.cost_usd), 0)::text AS spend_usd,
        COUNT(*)::text AS request_count,
        COUNT(DISTINCT t.actor)::text AS active_actors
      FROM transactions t
      WHERE t.organization_id = $1 
        AND t.status = 'success'
        AND t.created_at >= ${timeFilter}
      GROUP BY COALESCE(t.cost_center, 'default')
      ORDER BY SUM(t.cost_usd) DESC
      `,
      [session.orgId]
    );

    if (rows.length === 0) {
      return NextResponse.json({
        period,
        ledger: [],
        history: [],
        totalSpendUsd: 0,
      });
    }

    const totalSpend = rows.reduce((acc, r) => acc + parseFloat(r.spend_usd), 0);

    const ledger = rows.map((r) => {
      const spend = parseFloat(r.spend_usd);
      const sharePct = totalSpend > 0 ? (spend / totalSpend) * 100 : 0;
      return {
        costCenter: r.cost_center,
        team: r.cost_center.replace(/^CC-/, "").replace(/-\d+$/, ""),
        period: new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
        spend: Math.round(spend * 100) / 100,
        requests: parseInt(r.request_count, 10),
        activeUsers: parseInt(r.active_actors, 10),
        sharePct: Math.round(sharePct * 10) / 10,
        status: "settled",
      };
    });

    return NextResponse.json({
      period,
      ledger,
      history: [],
      totalSpendUsd: Math.round(totalSpend * 100) / 100,
    });
  } catch (err: any) {
    console.error("[/api/chargebacks GET error]:", err.message);
    return dbUnavailable();
  }
}

