/**
 * GET /api/cost-centers
 *
 * Returns cost center metrics grouped by transactions.cost_center:
 *   - name: Workspace name (or derived from cost_center code)
 *   - code: Cost center identifier
 *   - owner: Owner name (from metadata or default)
 *   - spendUsd: SUM(cost_usd) this month
 *   - lastMonthSpendUsd: SUM(cost_usd) last month
 *   - momGrowthPct: growth rate
 *   - transactionCount: total transactions count
 *   - status: classification based on budget limits (ok, warning, critical)
 *
 * Falls back to mock data when DATABASE_URL is not configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionFromRequest, unauthorizedResponse } from "@/lib/auth";
import type { CostCenterRow, CostCenterStatus } from "@/lib/types";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  if (!process.env.DATABASE_URL) {
    return NextResponse.json([]);
  }

  try {
    const pool = getPool();
    const monthStart = "date_trunc('month', now())";
    const prevMonthStart = "date_trunc('month', now() - interval '1 month')";

    const { rows } = await pool.query<{
      cost_center: string;
      workspace_name: string | null;
      owner: string | null;
      budget_cap: string | null;
      spend_usd: string;
      tx_count: string;
      last_month_spend: string;
    }>(`
      WITH current_month AS (
        SELECT cost_center,
               workspace_id,
               SUM(cost_usd) AS spend_usd,
               COUNT(*)      AS tx_count
        FROM   transactions
        WHERE  organization_id = $1
          AND  status     = 'success'
          AND  created_at >= ${monthStart}
        GROUP  BY cost_center, workspace_id
      ),
      last_month AS (
        SELECT cost_center,
               SUM(cost_usd) AS spend_usd
        FROM   transactions
        WHERE  organization_id = $1
          AND  status     = 'success'
          AND  created_at >= ${prevMonthStart}
          AND  created_at <  ${monthStart}
        GROUP  BY cost_center
      )
      SELECT
        c.cost_center,
        ws.name                                     AS workspace_name,
        ws.metadata->>'owner'                        AS owner,
        ws.budget_cap_usd::text                      AS budget_cap,
        c.spend_usd::text                            AS spend_usd,
        c.tx_count::text                             AS tx_count,
        COALESCE(l.spend_usd, 0)::text              AS last_month_spend
      FROM   current_month c
      LEFT   JOIN last_month   l  USING (cost_center)
      LEFT   JOIN workspaces   ws ON ws.id = c.workspace_id
      ORDER  BY c.spend_usd DESC
    `, [session.orgId]);


    const costCenters: CostCenterRow[] = rows.map((r) => {
      const spendUsd = parseFloat(r.spend_usd);
      const lastMonthSpendUsd = parseFloat(r.last_month_spend);
      const budgetCap = r.budget_cap ? parseFloat(r.budget_cap) : null;
      
      const momGrowthPct = lastMonthSpendUsd > 0
        ? ((spendUsd - lastMonthSpendUsd) / lastMonthSpendUsd) * 100
        : 0;

      // Determine status based on budget utilization
      let status: CostCenterStatus = "ok";
      if (budgetCap && budgetCap > 0) {
        const util = (spendUsd / budgetCap) * 100;
        if (util >= 100) status = "critical";
        else if (util >= 90) status = "warning";
      }

      // Format workspace name and owner
      const name = r.workspace_name ?? (r.cost_center === "default" ? "General Usage" : `Team ${r.cost_center}`);
      const owner = r.owner ?? "—";

      return {
        name,
        code: r.cost_center,
        owner,
        spendUsd,
        lastMonthSpendUsd,
        momGrowthPct: parseFloat(momGrowthPct.toFixed(1)),
        transactionCount: parseInt(r.tx_count, 10),
        status,
      };
    });

    return NextResponse.json(costCenters);
  } catch (err: any) {
    console.error("[/api/cost-centers] DB error, returning empty list:", err.message);
    return NextResponse.json([]);
  }
}
