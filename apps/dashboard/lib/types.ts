// Domain types for the Tokenistt CFO Dashboard (FinOps UI).
// These mirror the shapes produced by the Phase 3 / Prompt 5 (Postgres ledger)
// and Prompt 6 (ClickHouse analytics) backends, so the dashboard can later be
// wired to real API routes without changing the component layer.

export type Provider =
  | "openai"
  | "anthropic"
  | "bedrock"
  | "google"
  | "mistral"
  | "other";

export type CostCenterStatus = "ok" | "warning" | "critical";
export type AnomalySeverity = "high" | "medium" | "low";
export type ShadowAiStatus = "unreviewed" | "acknowledged" | "approved";
export type ReconciliationStatus =
  | "matched"
  | "over-billed"
  | "under-billed"
  | "missing";

export interface SummaryData {
  month: string; // "2026-07"
  monthLabel: string; // "July 2026"
  totalSpendUsd: number;
  budgetUsd: number;
  budgetUsedPct: number; // 0..100
  momGrowthPct: number; // vs previous month
  topCostCenters: { name: string; code: string; spendUsd: number; sharePct: number }[];
  anomalyCount: number;
  shadowAiSpendUsd: number;
  shadowAiCount: number;
}

export interface ProviderBreakdownRow {
  provider: Provider;
  label: string;
  spendUsd: number;
  sharePct: number;
  color: string;
}

export interface CostCenterRow {
  name: string;
  code: string;
  owner: string;
  spendUsd: number;
  lastMonthSpendUsd: number;
  momGrowthPct: number;
  transactionCount: number;
  status: CostCenterStatus;
}

export interface AnomalyAlert {
  id: string;
  actor: string;
  costCenter: string;
  spend24hUsd: number;
  avgDaily30dUsd: number;
  ratio: number; // spend24h / avgDaily30d
  severity: AnomalySeverity;
  detectedAt: string; // ISO
}

export interface ShadowAiEvent {
  id: string;
  detectedAt: string; // ISO
  actor: string; // may be "unknown"
  source: "card-transaction" | "browser-extension" | "expense-report" | "slack-integration" | "gateway-detection";
  vendor: string;
  amountUsd: number;
  status: ShadowAiStatus;
  note?: string;
}

export interface InvoiceLine {
  provider: string;
  period: string; // "2026-07"
  billedUsd: number;
  currency: string;
  invoiceNumber?: string;
  date?: string;
}

export interface ReconciliationRow {
  provider: string;
  calculatedUsd: number; // from ledger / analytics
  billedUsd: number; // from uploaded vendor invoice
  varianceUsd: number; // billed - calculated
  variancePct: number;
  status: ReconciliationStatus;
}

// ---------------------------------------------------------------------------
// Team Manager View (Prompt 8)
// ---------------------------------------------------------------------------

export type ModelTier = "frontier" | "standard" | "cheap";
export type TeamMemberStatus = "ok" | "warning" | "critical";
export type AlertChannel = "email" | "slack";
export type AlertMetric =
  | "team_spend_per_day"
  | "member_budget_pct"
  | "weekly_summary";

export interface MemberModelUsage {
  model: string; // e.g. "gpt-4o"
  label: string; // e.g. "GPT-4o"
  spendUsd: number;
  tier: ModelTier; // frontier (expensive) -> cheap
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  spendUsd: number; // month to date
  budgetUsd: number; // allocated budget
  calls: number;
  lastActive: string; // ISO
  status: TeamMemberStatus;
  models: MemberModelUsage[]; // per-member model mix
}

export interface TeamModelAggregate {
  model: string;
  label: string;
  tier: ModelTier;
  spendUsd: number;
  sharePct: number; // % of team spend
}

export interface TeamAlert {
  id: string;
  label: string; // human-readable rule
  metric: AlertMetric;
  threshold: number; // e.g. 100 (USD/day) or 90 (%)
  channel: AlertChannel;
  enabled: boolean;
}

export interface TeamView {
  managerName: string;
  teamName: string;
  period: string;
  members: TeamMember[];
  teamSpendUsd: number;
  teamBudgetUsd: number;
  teamBudgetUsedPct: number;
  dailySpendUsd: number; // today's spend (for the >$100/day rule)
  modelUsage: TeamModelAggregate[];
  alerts: TeamAlert[];
  budgetWarnPct: number; // e.g. 90 -> flag members >= 90%
}

export interface Policy {
  id: string;
  public_id: string;
  name: string;
  description?: string;
  is_enabled: boolean;
  conditions: {
    cost_center?: string;
    model?: string;
    cost_limit?: number;
    prompt_keyword?: string;
  };
  actions: {
    effect: 'block' | 'require_approval' | 'force_model';
    model?: string;
    message?: string;
  };
  created_at: string;
  updated_at: string;
}
