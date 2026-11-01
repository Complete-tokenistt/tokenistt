import { NextRequest, NextResponse } from "next/server";
import { getPool, isDbAvailable } from "@/lib/db";
import { dbUnavailable } from "@/lib/db-unavailable";
import { getSessionFromRequest, unauthorizedResponse } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const url = new URL(req.url);
  const period = url.searchParams.get("period") || "7d";

  const dbUp = await isDbAvailable();
  if (!dbUp) return dbUnavailable();

  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      actor: string;
      cost_center: string;
      provider: string;
      model: string;
      cost: number;
      mean_cost: number;
      std_cost: number;
      z_score: number;
      created_at: string;
    }>(
      `
      WITH baseline AS (
        SELECT 
          provider,
          AVG(cost_usd)::float AS mean_cost,
          COALESCE(STDDEV(cost_usd), 0)::float AS std_cost
        FROM transactions
        WHERE organization_id = $1
          AND status = 'success'
          AND created_at >= now() - interval '30 days'
          AND created_at < now() - interval '24 hours'
        GROUP BY provider
      ),
      recent AS (
        SELECT 
          t.id::text,
          COALESCE(t.actor, 'anonymous') AS actor,
          COALESCE(t.cost_center, 'default') AS cost_center,
          t.provider,
          t.model,
          t.cost_usd::float AS cost,
          t.created_at
        FROM transactions t
        WHERE t.organization_id = $1
          AND t.status = 'success'
          AND t.created_at >= now() - interval '24 hours'
      )
      SELECT 
        r.id,
        r.actor,
        r.cost_center,
        r.provider,
        r.model,
        r.cost,
        b.mean_cost,
        b.std_cost,
        CASE 
          WHEN b.std_cost > 0.001 THEN (r.cost - b.mean_cost) / b.std_cost 
          WHEN b.mean_cost > 0 THEN r.cost / b.mean_cost 
          ELSE 1.0 
        END AS z_score,
        r.created_at
      FROM recent r
      JOIN baseline b ON b.provider = r.provider
      WHERE (
        (b.std_cost > 0.001 AND (r.cost - b.mean_cost) / b.std_cost >= 2.0)
        OR (b.mean_cost > 0 AND r.cost >= b.mean_cost * 2.5)
      )
      ORDER BY r.cost DESC
      LIMIT 25
      `,
      [session.orgId]
    );

    if (rows.length === 0) {
      return NextResponse.json({
        period,
        count: 0,
        anomalies: [],
        source: "statistical_engine",
      });
    }

    const anomalies = rows.map((r) => {
      const ratio = Math.max(1.5, Math.round(r.z_score * 10) / 10);
      return {
        id: `anom-${r.id}`,
        actor: r.actor,
        costCenter: r.cost_center,
        provider: r.provider,
        model: r.model,
        spend24hUsd: Math.round(r.cost * 100) / 100,
        ratio,
        severity: ratio >= 3.0 ? "high" : "medium",
        detectedAt: r.created_at,
      };
    });

    return NextResponse.json({
      period,
      count: anomalies.length,
      anomalies,
      source: "statistical_engine",
    });
  } catch (err: any) {
    console.error("[/api/anomalies] error:", err.message);
    return dbUnavailable();
  }
}
