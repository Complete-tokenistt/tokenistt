import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getCostCenters } from "@/lib/mock-data";
import { getSessionFromRequest, unauthorizedResponse, forbiddenResponse } from "@/lib/auth";
import { can } from "@/lib/rbac";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ budgets: [] });
  }

  try {
    const pool = getPool();

    // 1. Try querying multi-level budgets table first
    const { rows: budgetRows } = await pool.query<{
      id: string;
      public_id: string;
      name: string | null;
      scope_type: string;
      scope_id: string;
      cap_usd: string;
      period: string;
      enforcement_mode: string;
    }>(
      `
      SELECT 
        id::text,
        public_id::text,
        name,
        scope_type,
        scope_id::text,
        cap_usd::text,
        period,
        enforcement_mode
      FROM budgets
      WHERE organization_id = $1 AND is_active = true
      ORDER BY created_at ASC
      `,
      [session.orgId]
    );

    if (budgetRows.length > 0) {
      // Calculate spend for each configured multi-level budget
      const budgets = await Promise.all(
        budgetRows.map(async (b) => {
          let spendQuery = `
            SELECT COALESCE(SUM(cost_usd), 0)::text AS spend
            FROM transactions
            WHERE organization_id = $1 AND status = 'success'
              AND created_at >= date_trunc('month', now())
          `;
          const params: any[] = [session.orgId];

          if (b.scope_type === "team") {
            spendQuery += " AND team_id = $2";
            params.push(b.scope_id);
          } else if (b.scope_type === "project") {
            spendQuery += " AND project_id = $2";
            params.push(b.scope_id);
          } else if (b.scope_type === "virtual_key") {
            spendQuery += " AND virtual_key_id = $2";
            params.push(b.scope_id);
          }

          const { rows: spendRows } = await pool.query<{ spend: string }>(spendQuery, params);
          const cap = parseFloat(b.cap_usd);
          const spend = parseFloat(spendRows[0]?.spend || "0");
          const pct = cap > 0 ? (spend / cap) * 100 : 0;

          return {
            id: b.id,
            public_id: b.public_id,
            name: b.name || `${b.scope_type} #${b.scope_id}`,
            scope_type: b.scope_type,
            scope_id: b.scope_id,
            budget_usd: cap,
            spend_usd: Math.round(spend * 100) / 100,
            percent_used: Math.round(pct * 10) / 10,
            period: b.period,
            enforcement_mode: b.enforcement_mode,
            status: pct >= 100 ? "exceeded" : pct >= 80 ? "warning" : "healthy",
          };
        })
      );

      return NextResponse.json({ budgets });
    }

    // 2. Fallback: Workspace-based budgets
    const { rows } = await pool.query<{
      id: string;
      name: string;
      cost_center: string;
      budget_cap_usd: string | null;
      spend_usd: string;
    }>(
      `
      SELECT 
        ws.id::text,
        ws.name,
        COALESCE(ws.cost_center, 'default') AS cost_center,
        ws.budget_cap_usd::text,
        COALESCE(SUM(t.cost_usd), 0)::text AS spend_usd
      FROM workspaces ws
      LEFT JOIN transactions t 
        ON t.workspace_id = ws.id 
        AND t.organization_id = ws.organization_id
        AND t.status = 'success'
        AND t.created_at >= date_trunc('month', now())
      WHERE ws.organization_id = $1
      GROUP BY ws.id, ws.name, ws.cost_center, ws.budget_cap_usd
      ORDER BY ws.name ASC
      `,
      [session.orgId]
    );

    const budgets = rows.map((r) => {
      const cap = r.budget_cap_usd ? parseFloat(r.budget_cap_usd) : 5000;
      const spend = parseFloat(r.spend_usd);
      const pct = cap > 0 ? (spend / cap) * 100 : 0;
      return {
        id: r.id,
        name: r.name,
        code: r.cost_center,
        cost_center: r.cost_center,
        scope_type: "workspace",
        budget_usd: cap,
        spend_usd: Math.round(spend * 100) / 100,
        percent_used: Math.round(pct * 10) / 10,
        status: pct >= 100 ? "exceeded" : pct >= 80 ? "warning" : "healthy",
      };
    });

    return NextResponse.json({ budgets });
  } catch (err: any) {
    console.error("[/api/budgets] DB error:", err.message);
    return NextResponse.json({ budgets: [] });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  if (!can(session.role, "budget:write")) {
    return forbiddenResponse("Insufficient permissions to create or edit budgets");
  }

  try {
    const body = await req.json();
    const {
      name,
      scope_type = "organization",
      scope_id = 0,
      cap_usd,
      period = "monthly",
      warn_threshold_pct = 80,
      critical_threshold_pct = 90,
      enforcement_mode = "hard_cap",
    } = body;

    if (!cap_usd || isNaN(parseFloat(cap_usd))) {
      return NextResponse.json({ error: "Field cap_usd is required and must be a number" }, { status: 400 });
    }

    if (!process.env.DATABASE_URL) {
      return NextResponse.json({
        success: true,
        budget: {
          id: "mock-budget-new",
          name: name || `${scope_type} Budget`,
          scope_type,
          cap_usd: parseFloat(cap_usd),
          period,
          enforcement_mode,
        },
      });
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `
      INSERT INTO budgets (
        organization_id,
        name,
        scope_type,
        scope_id,
        cap_usd,
        period,
        warn_threshold_pct,
        critical_threshold_pct,
        enforcement_mode,
        is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
      RETURNING id::text, public_id::text, name, scope_type, cap_usd, period, enforcement_mode
      `,
      [
        session.orgId,
        name || `${scope_type} Budget`,
        scope_type,
        scope_id,
        parseFloat(cap_usd),
        period,
        warn_threshold_pct,
        critical_threshold_pct,
        enforcement_mode,
      ]
    );

    return NextResponse.json({ success: true, budget: rows[0] });
  } catch (err: any) {
    console.error("[/api/budgets] POST error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
