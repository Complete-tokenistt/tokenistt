// ---------------------------------------------------------------------------
// Mock and Live database data layer for the Tokenistt CFO Dashboard.
//
// If DATABASE_URL is configured, this dynamically queries Postgres.
// Otherwise, it falls back to static mock data.
// ---------------------------------------------------------------------------

import type {
  AnomalyAlert,
  CostCenterRow,
  InvoiceLine,
  ModelTier,
  ProviderBreakdownRow,
  ReconciliationRow,
  ShadowAiEvent,
  SummaryData,
  TeamAlert,
  TeamMember,
  TeamModelAggregate,
  TeamView,
  AnomalySeverity,
  CostCenterStatus,
  TeamMemberStatus,
} from "./types";
import { PROVIDER_COLORS, PROVIDER_LABELS, MODEL_LABELS } from "./format";
import { getPool } from "./db";
import { loadIngestedShadowAi } from "./ingest";

const MONTH = "2026-07";
const MONTH_LABEL = "July 2026";
const BUDGET_USD = 25_000;

// --- Provider spend (also the "calculated" side of reconciliation) ----------
const PROVIDER_SPEND: { provider: ProviderBreakdownRow["provider"]; spendUsd: number }[] = [
  { provider: "openai", spendUsd: 12_400 },
  { provider: "anthropic", spendUsd: 6_200 },
  { provider: "bedrock", spendUsd: 2_100 },
  { provider: "google", spendUsd: 550 },
  { provider: "mistral", spendUsd: 180 },
];

const TOTAL_SPEND = PROVIDER_SPEND.reduce((s, p) => s + p.spendUsd, 0); // 21,430
const PREV_MONTH_SPEND = 19_070; // -> +12.4% MoM

// --- Cost centers -----------------------------------------------------------
const COST_CENTERS: CostCenterRow[] = [
  { name: "Engineering", code: "CC-1001", owner: "R. Patel", spendUsd: 5_200, lastMonthSpendUsd: 4_815, momGrowthPct: 8.0, transactionCount: 18_420, status: "ok" },
  { name: "Support", code: "CC-4401", owner: "M. Singh", spendUsd: 3_100, lastMonthSpendUsd: 2_696, momGrowthPct: 15.0, transactionCount: 12_940, status: "warning" },
  { name: "Product", code: "CC-2200", owner: "A. Rao", spendUsd: 2_400, lastMonthSpendUsd: 1_967, momGrowthPct: 22.0, transactionCount: 6_310, status: "ok" },
  { name: "Research", code: "CC-3100", owner: "K. Verma", spendUsd: 2_000, lastMonthSpendUsd: 1_695, momGrowthPct: 18.0, transactionCount: 4_120, status: "critical" },
  { name: "Data Science", code: "CC-3300", owner: "S. Iyer", spendUsd: 1_800, lastMonthSpendUsd: 1_875, momGrowthPct: -4.0, transactionCount: 3_540, status: "ok" },
  { name: "Marketing", code: "CC-5500", owner: "N. Khan", spendUsd: 1_200, lastMonthSpendUsd: 923, momGrowthPct: 30.0, transactionCount: 2_010, status: "warning" },
  { name: "Sales", code: "CC-5100", owner: "V. Joshi", spendUsd: 980, lastMonthSpendUsd: 933, momGrowthPct: 5.0, transactionCount: 1_640, status: "ok" },
  { name: "Security", code: "CC-3600", owner: "D. Mehta", spendUsd: 900, lastMonthSpendUsd: 873, momGrowthPct: 3.0, transactionCount: 1_120, status: "ok" },
  { name: "Operations", code: "CC-7000", owner: "P. Nair", spendUsd: 750, lastMonthSpendUsd: 765, momGrowthPct: -2.0, transactionCount: 980, status: "ok" },
  { name: "Customer Success", code: "CC-4500", owner: "L. Bose", spendUsd: 1_100, lastMonthSpendUsd: 1_010, momGrowthPct: 8.9, transactionCount: 2_780, status: "ok" },
  { name: "Finance", code: "CC-8000", owner: "T. Desai", spendUsd: 1_000, lastMonthSpendUsd: 980, momGrowthPct: 2.0, transactionCount: 410, status: "ok" },
  { name: "Unattributed", code: "CC-0000", owner: "—", spendUsd: 1_000, lastMonthSpendUsd: 839, momGrowthPct: 19.2, transactionCount: 720, status: "warning" },
];

// --- Anomaly alerts (>3x 30-day avg, from ClickHouse v_user_anomalies) -------
const ANOMALIES: AnomalyAlert[] = [
  { id: "an-1", actor: "spike@acme.io", costCenter: "Research", spend24hUsd: 480, avgDaily30dUsd: 45, ratio: 10.6, severity: "high", detectedAt: "2026-07-08T06:12:00Z" },
  { id: "an-2", actor: "tmp-bot@acme.io", costCenter: "Support", spend24hUsd: 95, avgDaily30dUsd: 20, ratio: 4.75, severity: "high", detectedAt: "2026-07-08T05:40:00Z" },
  { id: "an-3", actor: "dev-onboard@acme.io", costCenter: "Engineering", spend24hUsd: 150, avgDaily30dUsd: 40, ratio: 3.75, severity: "medium", detectedAt: "2026-07-08T04:55:00Z" },
  { id: "an-4", actor: "contractor-2@acme.io", costCenter: "Marketing", spend24hUsd: 210, avgDaily30dUsd: 60, ratio: 3.5, severity: "medium", detectedAt: "2026-07-07T22:10:00Z" },
];

// --- Shadow AI (expense-integration detections) ------------------------------
const SHADOW_AI: ShadowAiEvent[] = [
  { id: "sh-1", detectedAt: "2026-07-08T03:20:00Z", actor: "unknown", source: "card-transaction", vendor: "OpenAI", amountUsd: 89, status: "unreviewed", note: "Corporate card charge openai.com — no matching gateway key" },
  { id: "sh-2", detectedAt: "2026-07-07T18:05:00Z", actor: "j.doe@acme.io", source: "browser-extension", vendor: "OpenAI", amountUsd: 0, status: "unreviewed", note: "ChatGPT used outside the approved gateway" },
  { id: "sh-3", detectedAt: "2026-07-07T14:42:00Z", actor: "unknown", source: "slack-integration", vendor: "Anthropic", amountUsd: 49, status: "acknowledged", note: "Claude add-on billed via Slack/Zapier" },
  { id: "sh-4", detectedAt: "2026-07-06T11:30:00Z", actor: "unknown", source: "card-transaction", vendor: "Midjourney", amountUsd: 30, status: "unreviewed", note: "Personal Plus upgrade on corp card" },
  { id: "sh-5", detectedAt: "2026-07-05T09:15:00Z", actor: "a.roy@acme.io", source: "expense-report", vendor: "Anthropic", amountUsd: 20, status: "approved", note: "Claude Pro subscription (approved exception)" },
];

// --- Vendor invoices (the "billed" side of reconciliation) ------------------
const INVOICES: InvoiceLine[] = [
  { provider: "openai", period: MONTH, billedUsd: 12_640, currency: "USD" },
  { provider: "anthropic", period: MONTH, billedUsd: 6_150, currency: "USD" },
  { provider: "bedrock", period: MONTH, billedUsd: 2_100, currency: "USD" },
  { provider: "google", period: MONTH, billedUsd: 560, currency: "USD" },
  { provider: "mistral", period: MONTH, billedUsd: 180, currency: "USD" },
];

// ===========================================================================
// Helpers
// ===========================================================================
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

// ===========================================================================
// Getters
// ===========================================================================

export async function getSummary(): Promise<SummaryData> {
  if (!process.env.DATABASE_URL) {
    const top = [...COST_CENTERS]
      .sort((a, b) => b.spendUsd - a.spendUsd)
      .slice(0, 3)
      .map((c) => ({
        name: c.name,
        code: c.code,
        spendUsd: c.spendUsd,
        sharePct: (c.spendUsd / TOTAL_SPEND) * 100,
      }));

    const shadowSpend = SHADOW_AI.reduce((s, e) => s + e.amountUsd, 0);

    return {
      month: MONTH,
      monthLabel: MONTH_LABEL,
      totalSpendUsd: TOTAL_SPEND,
      budgetUsd: BUDGET_USD,
      budgetUsedPct: (TOTAL_SPEND / BUDGET_USD) * 100,
      momGrowthPct: ((TOTAL_SPEND - PREV_MONTH_SPEND) / PREV_MONTH_SPEND) * 100,
      topCostCenters: top,
      anomalyCount: ANOMALIES.length,
      shadowAiSpendUsd: shadowSpend,
      shadowAiCount: SHADOW_AI.length,
    };
  }

  try {
    const pool = getPool();
    const budgetUsd = parseFloat(process.env.MONTHLY_BUDGET_USD ?? '25000');

    const [spendRes, prevRes, topRes, anomalyRes, shadowRes] = await Promise.all([
      pool.query<{ total: string }>(`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM   transactions
        WHERE  status = 'success'
          AND  created_at >= date_trunc('month', now())
      `),
      pool.query<{ total: string }>(`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM   transactions
        WHERE  status = 'success'
          AND  created_at >= date_trunc('month', now()) - interval '1 month'
          AND  created_at <  date_trunc('month', now())
      `),
      pool.query<{ cost_center: string; spend: string }>(`
        SELECT cost_center,
               SUM(cost_usd)::text AS spend
        FROM   transactions
        WHERE  status = 'success'
          AND  created_at >= date_trunc('month', now())
        GROUP  BY cost_center
        ORDER  BY SUM(cost_usd) DESC
        LIMIT  3
      `),
      pool.query<{ cnt: string }>(`
        WITH daily_avg AS (
          SELECT actor,
                 SUM(cost_usd) / 30.0 AS avg_daily
          FROM   transactions
          WHERE  status = 'success'
            AND  created_at >= now() - interval '30 days'
          GROUP  BY actor
        ),
        spend_24h AS (
          SELECT actor,
                 SUM(cost_usd) AS spend
          FROM   transactions
          WHERE  status = 'success'
            AND  created_at >= now() - interval '24 hours'
          GROUP  BY actor
        )
        SELECT COUNT(*)::text AS cnt
        FROM   spend_24h s
        JOIN   daily_avg d USING (actor)
        WHERE  s.spend > d.avg_daily * 3
      `),
      pool.query<{ total: string; cnt: string }>(`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total,
               COUNT(*)::text AS cnt
        FROM   transactions
        WHERE  shadow_ai_flag = true
          AND  created_at >= date_trunc('month', now())
      `),
    ]);

    const totalSpendUsd = parseFloat(spendRes.rows[0].total || "0");
    const prevMonthSpend = parseFloat(prevRes.rows[0].total || "0");
    const momGrowthPct = prevMonthSpend > 0
      ? ((totalSpendUsd - prevMonthSpend) / prevMonthSpend) * 100
      : 0;

    const topCostCenters = topRes.rows.map((r) => ({
      name: r.cost_center === "default" ? "General Usage" : r.cost_center,
      code: r.cost_center,
      spendUsd: parseFloat(r.spend),
      sharePct: totalSpendUsd > 0 ? (parseFloat(r.spend) / totalSpendUsd) * 100 : 0,
    }));

    return {
      month: new Date().toISOString().slice(0, 7),
      monthLabel: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      totalSpendUsd,
      budgetUsd,
      budgetUsedPct: budgetUsd > 0 ? (totalSpendUsd / budgetUsd) * 100 : 0,
      momGrowthPct,
      topCostCenters,
      anomalyCount: parseInt(anomalyRes.rows[0].cnt || "0", 10),
      shadowAiSpendUsd: parseFloat(shadowRes.rows[0].total || "0"),
      shadowAiCount: parseInt(shadowRes.rows[0].cnt || "0", 10),
    };
  } catch (err: any) {
    console.error("Error in getSummary DB fetch:", err.message);
    return getSummaryMock();
  }
}

function getSummaryMock(): SummaryData {
  const top = [...COST_CENTERS]
    .sort((a, b) => b.spendUsd - a.spendUsd)
    .slice(0, 3)
    .map((c) => ({
      name: c.name,
      code: c.code,
      spendUsd: c.spendUsd,
      sharePct: (c.spendUsd / TOTAL_SPEND) * 100,
    }));

  const shadowSpend = SHADOW_AI.reduce((s, e) => s + e.amountUsd, 0);

  return {
    month: MONTH,
    monthLabel: MONTH_LABEL,
    totalSpendUsd: TOTAL_SPEND,
    budgetUsd: BUDGET_USD,
    budgetUsedPct: (TOTAL_SPEND / BUDGET_USD) * 100,
    momGrowthPct: ((TOTAL_SPEND - PREV_MONTH_SPEND) / PREV_MONTH_SPEND) * 100,
    topCostCenters: top,
    anomalyCount: ANOMALIES.length,
    shadowAiSpendUsd: shadowSpend,
    shadowAiCount: SHADOW_AI.length,
  };
}

export async function getProviderBreakdown(): Promise<ProviderBreakdownRow[]> {
  if (!process.env.DATABASE_URL) {
    return PROVIDER_SPEND.map((p) => ({
      provider: p.provider,
      label: PROVIDER_LABELS[p.provider] ?? p.provider,
      spendUsd: p.spendUsd,
      sharePct: (p.spendUsd / TOTAL_SPEND) * 100,
      color: PROVIDER_COLORS[p.provider] ?? PROVIDER_COLORS.other,
    })).sort((a, b) => b.spendUsd - a.spendUsd);
  }

  try {
    const pool = getPool();
    const [totalRes, spendRes] = await Promise.all([
      pool.query<{ total: string }>(`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM   transactions
        WHERE  status = 'success'
          AND  created_at >= date_trunc('month', now())
      `),
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
    return spendRes.rows.map((r) => {
      const providerKey = r.provider.toLowerCase() as ProviderBreakdownRow["provider"];
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
  } catch (err: any) {
    console.error("Error in getProviderBreakdown DB fetch:", err.message);
    return PROVIDER_SPEND.map((p) => ({
      provider: p.provider,
      label: PROVIDER_LABELS[p.provider] ?? p.provider,
      spendUsd: p.spendUsd,
      sharePct: (p.spendUsd / TOTAL_SPEND) * 100,
      color: PROVIDER_COLORS[p.provider] ?? PROVIDER_COLORS.other,
    })).sort((a, b) => b.spendUsd - a.spendUsd);
  }
}

export async function getCostCenters(): Promise<CostCenterRow[]> {
  if (!process.env.DATABASE_URL) {
    return [...COST_CENTERS].sort((a, b) => b.spendUsd - a.spendUsd);
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
        WHERE  status     = 'success'
          AND  created_at >= ${monthStart}
        GROUP  BY cost_center, workspace_id
      ),
      last_month AS (
        SELECT cost_center,
               SUM(cost_usd) AS spend_usd
        FROM   transactions
        WHERE  status     = 'success'
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
    `);

    return rows.map((r) => {
      const spendUsd = parseFloat(r.spend_usd);
      const lastMonthSpendUsd = parseFloat(r.last_month_spend);
      const budgetCap = r.budget_cap ? parseFloat(r.budget_cap) : null;
      
      const momGrowthPct = lastMonthSpendUsd > 0
        ? ((spendUsd - lastMonthSpendUsd) / lastMonthSpendUsd) * 100
        : 0;

      let status: CostCenterStatus = "ok";
      if (budgetCap && budgetCap > 0) {
        const util = (spendUsd / budgetCap) * 100;
        if (util >= 100) status = "critical";
        else if (util >= 90) status = "warning";
      }

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
  } catch (err: any) {
    console.error("Error in getCostCenters DB fetch:", err.message);
    return [...COST_CENTERS].sort((a, b) => b.spendUsd - a.spendUsd);
  }
}

export async function getAnomalies(ratioThreshold = 3): Promise<AnomalyAlert[]> {
  if (!process.env.DATABASE_URL) {
    return [...ANOMALIES].sort((a, b) => b.ratio - a.ratio);
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

    return rows.map((r, i) => {
      const ratio = parseFloat(r.ratio);
      const severity: AnomalySeverity = ratio >= 5 ? 'high' : ratio >= 3 ? 'medium' : 'low';
      return {
        id: `an-${i + 1}`,
        actor: r.actor,
        costCenter: r.cost_center ?? 'unknown',
        spend24hUsd: parseFloat(r.spend_24h),
        avgDaily30dUsd: parseFloat(r.avg_daily_30d),
        ratio: parseFloat(ratio.toFixed(2)),
        severity,
        detectedAt: r.latest_at,
      };
    });
  } catch (err: any) {
    console.error("Error in getAnomalies DB fetch:", err.message);
    return [...ANOMALIES].sort((a, b) => b.ratio - a.ratio);
  }
}

export async function getShadowAi(): Promise<ShadowAiEvent[]> {
  if (!process.env.DATABASE_URL) {
    return [...SHADOW_AI].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  }

  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      public_id: string;
      created_at: string;
      actor: string | null;
      provider: string;
      cost_usd: string;
      metadata: any;
    }>(`
      SELECT public_id,
             created_at::text AS created_at,
             actor,
             provider,
             cost_usd::text AS cost_usd,
             metadata
      FROM   transactions
      WHERE  shadow_ai_flag = true
      ORDER  BY created_at DESC
      LIMIT  50
    `);

    const scannerEvents = loadIngestedShadowAi();
    const dbEvents: ShadowAiEvent[] = rows.map((r) => ({
      id: r.public_id,
      detectedAt: r.created_at,
      actor: r.actor ?? "unknown",
      source: "slack-integration",
      vendor: r.provider,
      amountUsd: parseFloat(r.cost_usd),
      status: "unreviewed",
      note: r.metadata?.note ?? `Gateway flagged: unauthorized model access by ${r.actor}`,
    }));

    return [...dbEvents, ...scannerEvents].sort(
      (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
    );
  } catch (err: any) {
    console.error("Error in getShadowAi DB fetch:", err.message);
    return [...SHADOW_AI].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  }
}

export async function getInvoices(): Promise<InvoiceLine[]> {
  if (!process.env.DATABASE_URL) {
    return [...INVOICES];
  }

  try {
    const pool = getPool();
    const { rows } = await pool.query<{ provider: string; period: string; billed: string }>(`
      SELECT provider,
             date_trunc('month', period_start)::date::text AS period,
             net_amount_usd::text AS billed
      FROM   provider_invoices
      ORDER  BY period_start DESC
    `);
    
    if (rows.length === 0) {
      return [...INVOICES];
    }
    
    return rows.map((r) => ({
      provider: r.provider,
      period: r.period.slice(0, 7),
      billedUsd: parseFloat(r.billed),
      currency: "USD",
    }));
  } catch (err: any) {
    console.error("Error in getInvoices DB fetch:", err.message);
    return [...INVOICES];
  }
}

export function getCalculatedByProvider(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const p of PROVIDER_SPEND) map[p.provider] = p.spendUsd;
  return map;
}

export async function reconcile(invoices: InvoiceLine[]): Promise<ReconciliationRow[]> {
  if (!process.env.DATABASE_URL) {
    const calculated = getCalculatedByProvider();
    const seen = new Set<string>();

    const rows: ReconciliationRow[] = invoices.map((inv) => {
      const key = inv.provider.toLowerCase();
      seen.add(key);
      const calc = calculated[key] ?? 0;
      const variance = inv.billedUsd - calc;
      const variancePct = calc === 0 ? 100 : (variance / calc) * 100;
      let status: ReconciliationRow["status"] = "matched";
      if (Math.abs(variancePct) <= 1) status = "matched";
      else if (variance > 0) status = "over-billed";
      else status = "under-billed";
      return {
        provider: PROVIDER_LABELS[key] ?? key,
        calculatedUsd: calc,
        billedUsd: inv.billedUsd,
        varianceUsd: variance,
        variancePct,
        status,
      };
    });

    for (const [key, calc] of Object.entries(calculated)) {
      if (!seen.has(key)) {
        rows.push({
          provider: PROVIDER_LABELS[key] ?? key,
          calculatedUsd: calc,
          billedUsd: 0,
          varianceUsd: -calc,
          variancePct: -100,
          status: "missing",
        });
      }
    }

    return rows;
  }

  try {
    const pool = getPool();
    const { rows: dbRows } = await pool.query<{ provider: string; spend: string }>(`
      SELECT provider,
             SUM(cost_usd)::text AS spend
      FROM   transactions
      WHERE  status = 'success'
        AND  created_at >= date_trunc('month', now())
      GROUP  BY provider
    `);

    const calculated: Record<string, number> = {};
    for (const r of dbRows) {
      calculated[r.provider.toLowerCase()] = parseFloat(r.spend);
    }

    const seen = new Set<string>();
    const reconRows: ReconciliationRow[] = invoices.map((inv) => {
      const key = inv.provider.toLowerCase();
      seen.add(key);
      const calc = calculated[key] ?? 0;
      const variance = inv.billedUsd - calc;
      const variancePct = calc === 0 ? 100 : (variance / calc) * 100;

      let status: ReconciliationRow["status"] = "matched";
      if (Math.abs(variancePct) <= 1) status = "matched";
      else if (variance > 0) status = "over-billed";
      else status = "under-billed";

      return {
        provider: PROVIDER_LABELS[key] ?? key,
        calculatedUsd: calc,
        billedUsd: inv.billedUsd,
        varianceUsd: parseFloat(variance.toFixed(2)),
        variancePct: parseFloat(variancePct.toFixed(2)),
        status,
      };
    });

    for (const [key, calc] of Object.entries(calculated)) {
      if (!seen.has(key)) {
        reconRows.push({
          provider: PROVIDER_LABELS[key] ?? key,
          calculatedUsd: calc,
          billedUsd: 0,
          varianceUsd: -calc,
          variancePct: -100,
          status: "missing",
        });
      }
    }

    return reconRows;
  } catch (err: any) {
    console.error("Error in reconcile DB fetch:", err.message);
    return [];
  }
}

// ===========================================================================
// Team Manager View
// ===========================================================================

const TEAM_MANAGER = "R. Patel";
const TEAM_NAME = "Engineering";

const TEAM_MEMBERS: TeamMember[] = [
  {
    id: "u-sarah",
    name: "Sarah",
    email: "sarah@acme.io",
    spendUsd: 45,
    budgetUsd: 50,
    calls: 320,
    lastActive: "2026-07-08T06:30:00Z",
    status: "warning",
    models: [
      { model: "gpt-4o", label: "GPT-4o", spendUsd: 30, tier: "frontier" },
      { model: "gpt-4o-mini", label: "GPT-4o-mini", spendUsd: 10, tier: "cheap" },
      { model: "claude-3-haiku", label: "Haiku", spendUsd: 5, tier: "cheap" },
    ],
  },
  {
    id: "u-tom",
    name: "Tom",
    email: "tom@acme.io",
    spendUsd: 28,
    budgetUsd: 60,
    calls: 410,
    lastActive: "2026-07-08T05:10:00Z",
    status: "ok",
    models: [
      { model: "gpt-4o", label: "GPT-4o", spendUsd: 18, tier: "frontier" },
      { model: "claude-3-5-sonnet", label: "Claude Sonnet", spendUsd: 6, tier: "standard" },
      { model: "claude-3-haiku", label: "Haiku", spendUsd: 4, tier: "cheap" },
    ],
  },
  {
    id: "u-priya",
    name: "Priya",
    email: "priya@acme.io",
    spendUsd: 12,
    budgetUsd: 40,
    calls: 150,
    lastActive: "2026-07-07T20:00:00Z",
    status: "ok",
    models: [
      { model: "claude-3-haiku", label: "Haiku", spendUsd: 7, tier: "cheap" },
      { model: "gpt-4o-mini", label: "GPT-4o-mini", spendUsd: 5, tier: "cheap" },
    ],
  },
  {
    id: "u-alex",
    name: "Alex",
    email: "alex@acme.io",
    spendUsd: 33,
    budgetUsd: 50,
    calls: 280,
    lastActive: "2026-07-08T04:45:00Z",
    status: "ok",
    models: [
      { model: "gpt-4o", label: "GPT-4o", spendUsd: 20, tier: "frontier" },
      { model: "claude-3-haiku", label: "Haiku", spendUsd: 8, tier: "cheap" },
      { model: "gpt-4o-mini", label: "GPT-4o-mini", spendUsd: 5, tier: "cheap" },
    ],
  },
  {
    id: "u-nina",
    name: "Nina",
    email: "nina@acme.io",
    spendUsd: 8,
    budgetUsd: 30,
    calls: 90,
    lastActive: "2026-07-07T15:20:00Z",
    status: "ok",
    models: [
      { model: "claude-3-haiku", label: "Haiku", spendUsd: 6, tier: "cheap" },
      { model: "gpt-4o-mini", label: "GPT-4o-mini", spendUsd: 2, tier: "cheap" },
    ],
  },
];

const TEAM_ALERTS: TeamAlert[] = [
  {
    id: "al-1",
    label: "Notify me when team spend > $100/day",
    metric: "team_spend_per_day",
    threshold: 100,
    channel: "email",
    enabled: true,
  },
  {
    id: "al-2",
    label: "Alert when a member passes 90% of their budget",
    metric: "member_budget_pct",
    threshold: 90,
    channel: "slack",
    enabled: true,
  },
  {
    id: "al-3",
    label: "Weekly team summary (Mondays)",
    metric: "weekly_summary",
    threshold: 0,
    channel: "email",
    enabled: false,
  },
];

export async function getTeamView(): Promise<TeamView> {
  if (!process.env.DATABASE_URL) {
    const members = TEAM_MEMBERS;
    const teamSpendUsd = members.reduce((s, m) => s + m.spendUsd, 0);
    const teamBudgetUsd = members.reduce((s, m) => s + m.budgetUsd, 0);
    const dailySpendUsd = 96;

    const agg = new Map<string, { label: string; tier: ModelTier; spendUsd: number }>();
    for (const m of members) {
      for (const mm of m.models) {
        const e = agg.get(mm.model) ?? { label: mm.label, tier: mm.tier, spendUsd: 0 };
        e.spendUsd += mm.spendUsd;
        agg.set(mm.model, e);
      }
    }
    const modelUsage: TeamModelAggregate[] = [...agg.entries()]
      .map(([model, e]) => ({
        model,
        label: e.label,
        tier: e.tier,
        spendUsd: e.spendUsd,
        sharePct: teamSpendUsd > 0 ? (e.spendUsd / teamSpendUsd) * 100 : 0,
      }))
      .sort((a, b) => b.spendUsd - a.spendUsd);

    return {
      managerName: TEAM_MANAGER,
      teamName: TEAM_NAME,
      period: MONTH_LABEL,
      members,
      teamSpendUsd,
      teamBudgetUsd,
      teamBudgetUsedPct: (teamSpendUsd / teamBudgetUsd) * 100,
      dailySpendUsd,
      modelUsage,
      alerts: TEAM_ALERTS,
      budgetWarnPct: 90,
    };
  }

  try {
    const pool = getPool();
    const monthStart = "date_trunc('month', now())";
    const dayStart = "date_trunc('day', now())";

    const [memberRes, modelRes, dailyRes] = await Promise.all([
      pool.query<{
        actor: string;
        spend_usd: string;
        call_count: string;
        last_active: string;
        cost_center: string;
      }>(`
        SELECT actor,
               SUM(cost_usd)::text AS spend_usd,
               COUNT(*)::text AS call_count,
               MAX(created_at)::text AS last_active,
               MAX(cost_center) AS cost_center
        FROM   transactions
        WHERE  status = 'success'
          AND  created_at >= ${monthStart}
          AND  actor IS NOT NULL
        GROUP  BY actor
        ORDER  BY SUM(cost_usd) DESC
        LIMIT  50
      `),
      pool.query<{
        actor: string;
        model: string;
        spend_usd: string;
      }>(`
        SELECT actor,
               model,
               SUM(cost_usd)::text AS spend_usd
        FROM   transactions
        WHERE  status = 'success'
          AND  created_at >= ${monthStart}
          AND  actor IS NOT NULL
        GROUP  BY actor, model
        ORDER  BY actor, SUM(cost_usd) DESC
      `),
      pool.query<{ total: string }>(`
        SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM   transactions
        WHERE  status = 'success'
          AND  created_at >= ${dayStart}
      `),
    ]);

    const modelByActor = new Map<string, { model: string; label: string; spendUsd: number; tier: ModelTier }[]>();
    for (const row of modelRes.rows) {
      const arr = modelByActor.get(row.actor) ?? [];
      arr.push({
        model: row.model,
        label: MODEL_LABELS[row.model] ?? row.model,
        spendUsd: parseFloat(row.spend_usd),
        tier: inferTier(row.model),
      });
      modelByActor.set(row.actor, arr);
    }

    const members = memberRes.rows.map((r, i) => {
      const spendUsd = parseFloat(r.spend_usd);
      const budgetUsd = 50;
      return {
        id: `u-${i}`,
        name: r.actor.split('@')[0] ?? r.actor,
        email: r.actor,
        spendUsd,
        budgetUsd,
        calls: parseInt(r.call_count, 10),
        lastActive: r.last_active,
        status: inferStatus(spendUsd, budgetUsd),
        models: modelByActor.get(r.actor) ?? [],
      };
    });

    const teamSpendUsd = members.reduce((s, m) => s + m.spendUsd, 0);
    const teamBudgetUsd = members.reduce((s, m) => s + m.budgetUsd, 0);
    const dailySpendUsd = parseFloat(dailyRes.rows[0].total || "0");

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
        label: e.label,
        tier: e.tier,
        spendUsd: e.spendUsd,
        sharePct: teamSpendUsd > 0 ? (e.spendUsd / teamSpendUsd) * 100 : 0,
      }))
      .sort((a, b) => b.spendUsd - a.spendUsd);

    return {
      managerName: 'Dashboard',
      teamName: 'All Teams',
      period: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      members,
      teamSpendUsd,
      teamBudgetUsd,
      teamBudgetUsedPct: teamBudgetUsd > 0 ? (teamSpendUsd / teamBudgetUsd) * 100 : 0,
      dailySpendUsd,
      modelUsage,
      alerts: [],
      budgetWarnPct: 90,
    };
  } catch (err: any) {
    console.error("Error in getTeamView DB fetch:", err.message);
    return getTeamViewMock();
  }
}

function getTeamViewMock(): TeamView {
  const members = TEAM_MEMBERS;
  const teamSpendUsd = members.reduce((s, m) => s + m.spendUsd, 0);
  const teamBudgetUsd = members.reduce((s, m) => s + m.budgetUsd, 0);
  const dailySpendUsd = 96;

  const agg = new Map<string, { label: string; tier: ModelTier; spendUsd: number }>();
  for (const m of members) {
    for (const mm of m.models) {
      const e = agg.get(mm.model) ?? { label: mm.label, tier: mm.tier, spendUsd: 0 };
      e.spendUsd += mm.spendUsd;
      agg.set(mm.model, e);
    }
  }
  const modelUsage: TeamModelAggregate[] = [...agg.entries()]
    .map(([model, e]) => ({
      model,
      label: e.label,
      tier: e.tier,
      spendUsd: e.spendUsd,
      sharePct: teamSpendUsd > 0 ? (e.spendUsd / teamSpendUsd) * 100 : 0,
    }))
    .sort((a, b) => b.spendUsd - a.spendUsd);

  return {
    managerName: TEAM_MANAGER,
    teamName: TEAM_NAME,
    period: MONTH_LABEL,
    members,
    teamSpendUsd,
    teamBudgetUsd,
    teamBudgetUsedPct: (teamSpendUsd / teamBudgetUsd) * 100,
    dailySpendUsd,
    modelUsage,
    alerts: TEAM_ALERTS,
    budgetWarnPct: 90,
  };
}
