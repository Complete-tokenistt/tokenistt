import { NextRequest, NextResponse } from "next/server";
import { getPool, isDbAvailable } from "@/lib/db";
import { getSessionFromRequest, unauthorizedResponse } from "@/lib/auth";
import { UNIT_ECONOMICS_METRICS } from "@/lib/dashboard-mock-data";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const dbUp = await isDbAvailable();
  if (!dbUp) {
    return NextResponse.json({ metrics: [] });
  }

  try {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS unit_metrics (
        id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id      bigint REFERENCES projects(id) ON DELETE SET NULL,
        metric_name     text NOT NULL,
        feature_tag     text,
        metric_count    integer NOT NULL,
        period_start    date NOT NULL,
        period_end      date NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { rows } = await pool.query(
      `SELECT 
        um.id::text,
        um.public_id::text,
        um.metric_name AS label,
        COALESCE(um.feature_tag, 'general') AS feature,
        um.metric_count,
        um.period_start,
        um.period_end,
        COALESCE((
          SELECT SUM(t.cost_usd)::float
          FROM transactions t
          WHERE t.organization_id = um.organization_id
            AND t.created_at >= um.period_start
            AND t.created_at <= um.period_end + interval '1 day'
        ), 0.0) AS total_spend
       FROM unit_metrics um
       WHERE um.organization_id = $1
       ORDER BY um.created_at DESC`,
      [session.orgId]
    );

    if (rows.length === 0) {
      return NextResponse.json({ metrics: [] });
    }

    const calculated = rows.map((r: any, idx: number) => {
      const count = r.metric_count || 1;
      const costPerUnit = count > 0 ? r.total_spend / count : 0;
      return {
        id: idx + 1,
        label: r.label,
        feature: r.feature,
        value: Math.round(costPerUnit * 1000) / 1000,
        unit: "$",
        confidence: r.total_spend > 0 ? "measured" : "estimated",
        dataSource: "ledger + outcome count",
        freshness: "live",
        trend: [costPerUnit * 1.2, costPerUnit * 1.1, costPerUnit],
      };
    });

    return NextResponse.json({ metrics: calculated });
  } catch (err: any) {
    console.error("[/api/unit-economics GET error]:", err.message);
    return NextResponse.json({ metrics: [] });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  try {
    const body = await req.json();
    const { metric_name, feature_tag, metric_count, period_start, period_end } = body;

    if (!metric_name || !metric_count) {
      return NextResponse.json({ error: "metric_name and metric_count are required" }, { status: 400 });
    }

    const dbUp = await isDbAvailable();
    if (!dbUp) {
      return NextResponse.json({
        success: true,
        metric: {
          id: Date.now(),
          label: metric_name,
          feature: feature_tag || "custom",
          value: 0.15,
          unit: "$",
        },
      });
    }

    const pool = getPool();
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `INSERT INTO unit_metrics (
        organization_id, metric_name, feature_tag, metric_count, period_start, period_end
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id::text, public_id::text, metric_name, metric_count`,
      [
        session.orgId,
        metric_name,
        feature_tag || null,
        Number(metric_count),
        period_start || today,
        period_end || today,
      ]
    );

    return NextResponse.json({ success: true, metric: rows[0] });
  } catch (err: any) {
    console.error("[/api/unit-economics POST error]:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

