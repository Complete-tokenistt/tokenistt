/**
 * GET /api/team
 *
 * Returns team attribution data grouped by workspace (cost_center):
 *   - Per-member spend, call count, model mix, last-active
 *   - Daily spend total (for the >$100/day alert rule)
 *   - Team-level model usage aggregate
 *
 * Falls back to mock data when DATABASE_URL is not configured.
 */

import { NextResponse } from 'next/server';
import { getPool }      from '@/lib/db';
import { getTeamView }  from '@/lib/mock-data';
import { MODEL_LABELS } from '@/lib/format';
import type { ModelTier, TeamMemberStatus } from '@/lib/types';

function inferTier(model: string): ModelTier {
  if (/opus|gpt-4(?!o-mini)|o1/.test(model)) return 'frontier';
  if (/sonnet|gpt-4o(?!-mini)|claude-3-5/.test(model)) return 'standard';
  return 'cheap';
}

function inferStatus(spendUsd: number, budgetUsd: number): TeamMemberStatus {
  const pct = budgetUsd > 0 ? (spendUsd / budgetUsd) * 100 : 0;
  if (pct >= 100) return 'critical';
  if (pct >= 90)  return 'warning';
  return 'ok';
}

export async function GET() {
  // ── Fallback: no DB ────────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(await getTeamView());
  }

  try {
    const pool = getPool();
    const monthStart = "date_trunc('month', now())";
    const dayStart   = "date_trunc('day', now())";

    const [memberRes, modelRes, dailyRes] = await Promise.all([
      // 1. Per-actor spend + call count this month
      pool.query<{
        actor:          string;
        spend_usd:      string;
        call_count:     string;
        last_active:    string;
        cost_center:    string;
      }>(`
        SELECT actor,
               SUM(cost_usd)::text                    AS spend_usd,
               COUNT(*)::text                         AS call_count,
               MAX(created_at)::text                  AS last_active,
               MAX(cost_center)                       AS cost_center
        FROM   transactions
        WHERE  status     = 'success'
          AND  created_at >= ${monthStart}
          AND  actor IS NOT NULL
        GROUP  BY actor
        ORDER  BY SUM(cost_usd) DESC
        LIMIT  50
      `),

      // 2. Per-actor per-model spend this month
      pool.query<{
        actor:      string;
        model:      string;
        spend_usd:  string;
      }>(`
        SELECT actor,
               model,
               SUM(cost_usd)::text AS spend_usd
        FROM   transactions
        WHERE  status     = 'success'
          AND  created_at >= ${monthStart}
          AND  actor IS NOT NULL
        GROUP  BY actor, model
        ORDER  BY actor, SUM(cost_usd) DESC
      `),

      // 3. Today's team total spend
      pool.query<{ total: string }>(`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM   transactions
        WHERE  status     = 'success'
          AND  created_at >= ${dayStart}
      `),
    ]);

    // Build model-map keyed by actor
    const modelByActor = new Map<string, { model: string; label: string; spendUsd: number; tier: ModelTier }[]>();
    for (const row of modelRes.rows) {
      const arr = modelByActor.get(row.actor) ?? [];
      arr.push({
        model:    row.model,
        label:    MODEL_LABELS[row.model] ?? row.model,
        spendUsd: parseFloat(row.spend_usd),
        tier:     inferTier(row.model),
      });
      modelByActor.set(row.actor, arr);
    }

    const members = memberRes.rows.map((r, i) => {
      const spendUsd  = parseFloat(r.spend_usd);
      const budgetUsd = 50; // default per-member budget; wire to virtual_keys.budget_cap_usd when available
      return {
        id:         `u-${i}`,
        name:       r.actor.split('@')[0] ?? r.actor,
        email:      r.actor,
        spendUsd,
        budgetUsd,
        calls:      parseInt(r.call_count, 10),
        lastActive: r.last_active,
        status:     inferStatus(spendUsd, budgetUsd),
        models:     modelByActor.get(r.actor) ?? [],
      };
    });

    const teamSpendUsd  = members.reduce((s, m) => s + m.spendUsd, 0);
    const teamBudgetUsd = members.reduce((s, m) => s + m.budgetUsd, 0);
    const dailySpendUsd = parseFloat(dailyRes.rows[0].total);

    // Aggregate model usage across team
    const agg = new Map<string, { label: string; tier: ModelTier; spendUsd: number }>();
    for (const m of members) {
      for (const mm of m.models) {
        const e = agg.get(mm.model) ?? { label: mm.label, tier: mm.tier, spendUsd: 0 };
        e.spendUsd += mm.spendUsd;
        agg.set(mm.model, e);
      }
    }
    const modelUsage = [...agg.entries()]
      .map(([model, e]) => ({
        model,
        label:    e.label,
        tier:     e.tier,
        spendUsd: e.spendUsd,
        sharePct: teamSpendUsd > 0 ? (e.spendUsd / teamSpendUsd) * 100 : 0,
      }))
      .sort((a, b) => b.spendUsd - a.spendUsd);

    return NextResponse.json({
      managerName:        'Dashboard',
      teamName:           'All Teams',
      period:             new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      members,
      teamSpendUsd,
      teamBudgetUsd,
      teamBudgetUsedPct:  teamBudgetUsd > 0 ? (teamSpendUsd / teamBudgetUsd) * 100 : 0,
      dailySpendUsd,
      modelUsage,
      alerts:             [],
      budgetWarnPct:      90,
      _source:            'postgres',
    });
  } catch (err: any) {
    console.error('[/api/team] DB error, falling back to mock:', err.message);
    return NextResponse.json({ ...getTeamView(), _source: 'mock_fallback' });
  }
}
