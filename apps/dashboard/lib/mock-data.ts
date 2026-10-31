// ---------------------------------------------------------------------------
// Mock data layer for the Tokenistt CFO Dashboard.
//
// Everything here is deterministic (hardcoded, no Math.random) so server and
// client renders match and there are no hydration mismatches. The shapes mirror
// the Phase 3 backends:
//   - Postgres ledger (Prompt 5): `transactions`, `provider_invoices`
//   - ClickHouse analytics (Prompt 6): `daily_spend_by_provider`,
//     `daily_spend_by_cost_center`, `mv_*_daily` rollups
//
// TO WIRE TO REAL DATA: replace each `get*` function below with a call to your
// API route / DB client (the `app/api/*/route.ts` files already call these
// functions, so you only change the body of the getters).
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
} from "./types";
import { PROVIDER_COLORS, PROVIDER_LABELS } from "./format";

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
// Getters (swap bodies for real DB/API calls)
// ===========================================================================

export function getSummary(): SummaryData {
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

export function getProviderBreakdown(): ProviderBreakdownRow[] {
  return PROVIDER_SPEND.map((p) => ({
    provider: p.provider,
    label: PROVIDER_LABELS[p.provider] ?? p.provider,
    spendUsd: p.spendUsd,
    sharePct: (p.spendUsd / TOTAL_SPEND) * 100,
    color: PROVIDER_COLORS[p.provider] ?? PROVIDER_COLORS.other,
  })).sort((a, b) => b.spendUsd - a.spendUsd);
}

export function getCostCenters(): CostCenterRow[] {
  return [...COST_CENTERS].sort((a, b) => b.spendUsd - a.spendUsd);
}

export function getAnomalies(): AnomalyAlert[] {
  return [...ANOMALIES].sort((a, b) => b.ratio - a.ratio);
}

export function getShadowAi(): ShadowAiEvent[] {
  return [...SHADOW_AI].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

export function getInvoices(): InvoiceLine[] {
  return [...INVOICES];
}

// Calculated (ledger) spend by provider — used as reconciliation baseline.
export function getCalculatedByProvider(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const p of PROVIDER_SPEND) map[p.provider] = p.spendUsd;
  return map;
}

// Reconcile uploaded/known invoices against ledger-calculated costs.
export function reconcile(invoices: InvoiceLine[]): ReconciliationRow[] {
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

  // Any provider we track but have no invoice for -> missing.
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

// ===========================================================================
// Team Manager View (Prompt 8)
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
    status: "warning", // 90% of budget used
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

// Pre-configured alert rules for the manager (editable in the UI).
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

export function getTeamView(): TeamView {
  const members = TEAM_MEMBERS;
  const teamSpendUsd = members.reduce((s, m) => s + m.spendUsd, 0);
  const teamBudgetUsd = members.reduce((s, m) => s + m.budgetUsd, 0);
  const dailySpendUsd = 96; // under the $100/day alert threshold

  // Aggregate model spend across the team (keeps totals consistent with members).
  const agg = new Map<
    string,
    { label: string; tier: ModelTier; spendUsd: number }
  >();
  for (const m of members) {
    for (const mm of m.models) {
      const e = agg.get(mm.model) ?? {
        label: mm.label,
        tier: mm.tier,
        spendUsd: 0,
      };
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
