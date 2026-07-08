// Ported from tokenistt marketing-site (src/lib/dashboardData.js).
// Local/illustrative data for the net-new dashboard sections that have no
// backend yet (budgets, routing, cost-attribution, chargebacks,
// unit-economics, forecasting, roi, model-comparison, simulator,
// board-reports, usage, onboarding) — same as it was in the source, which
// explicitly ran these pages client-only with nothing sent to a server.

export const TEAMS = [
  { id: "support-ai", name: "support-ai", provider: "OpenAI", spend: 4820, cap: 6000, trend: [22, 28, 34, 30, 38, 46, 52], owner: "R. Fernandez", costCenter: "CS-100 · Customer Support" },
  { id: "agents-platform", name: "agents-platform", provider: "Anthropic", spend: 5620, cap: 5000, trend: [18, 24, 30, 38, 44, 52, 60], owner: "A. Tiwari", over: true, costCenter: "ENG-210 · Platform" },
  { id: "doc-search", name: "doc-search", provider: "Google", spend: 1180, cap: 3000, trend: [12, 14, 15, 16, 18, 17, 19], owner: "S. Okafor", costCenter: "ENG-220 · Search" },
  { id: "internal-tools", name: "internal-tools", provider: "Mixed", spend: 640, cap: 2000, trend: [8, 9, 8, 10, 9, 11, 10], owner: "J. Park", costCenter: "OPS-300 · Internal Tools" },
  { id: "growth-agents", name: "growth-agents", provider: "DeepSeek", spend: 420, cap: 1500, trend: [4, 5, 6, 5, 7, 8, 9], owner: "A. Tiwari", costCenter: "MKT-410 · Growth" },
];

const USAGE_SEED: [string, string, string, string, number, number, number, string][] = [
  ["support-ai", "zendesk-triage", "OpenAI", "gpt-4o-mini", 1240, 180, 612, "success"],
  ["agents-platform", "code-review", "Anthropic", "claude-sonnet-4.5", 3400, 820, 1440, "success"],
  ["doc-search", "handbook-qa", "Google", "gemini-2.5-flash", 2100, 260, 540, "success"],
  ["support-ai", "zendesk-triage", "OpenAI", "gpt-4o-mini", 980, 140, 780, "success"],
  ["agents-platform", "agent-runner", "Anthropic", "claude-haiku-4.5", 1600, 310, 612, "success"],
  ["internal-tools", "slack-copilot", "DeepSeek", "deepseek-v3", 860, 120, 690, "success"],
  ["growth-agents", "ad-copy-gen", "DeepSeek", "deepseek-v3", 540, 210, 704, "success"],
  ["support-ai", "zendesk-triage", "OpenAI", "gpt-4o-mini", 1120, 160, 918, "error"],
  ["agents-platform", "code-review", "Anthropic", "claude-sonnet-4.5", 4200, 960, 1510, "success"],
  ["doc-search", "handbook-qa", "Google", "gemini-2.5-flash", 1980, 240, 520, "success"],
  ["agents-platform", "agent-runner", "Anthropic", "claude-haiku-4.5", 1450, 290, 604, "success"],
  ["support-ai", "zendesk-triage", "OpenAI", "gpt-4o-mini", 1310, 190, 742, "throttled"],
  ["internal-tools", "slack-copilot", "DeepSeek", "deepseek-v3", 720, 100, 660, "success"],
  ["doc-search", "handbook-qa", "Google", "gemini-2.5-flash", 2260, 280, 558, "success"],
  ["agents-platform", "code-review", "Anthropic", "claude-sonnet-4.5", 3900, 890, 1480, "success"],
  ["growth-agents", "ad-copy-gen", "DeepSeek", "deepseek-v3", 610, 230, 712, "success"],
  ["support-ai", "zendesk-triage", "OpenAI", "gpt-4o-mini", 1050, 150, 690, "success"],
  ["agents-platform", "agent-runner", "Anthropic", "claude-haiku-4.5", 1520, 300, 618, "error"],
  ["internal-tools", "slack-copilot", "DeepSeek", "deepseek-v3", 790, 110, 674, "success"],
  ["doc-search", "handbook-qa", "Google", "gemini-2.5-flash", 2040, 250, 546, "success"],
  ["support-ai", "zendesk-triage", "OpenAI", "gpt-4o-mini", 1180, 170, 706, "success"],
  ["agents-platform", "code-review", "Anthropic", "claude-sonnet-4.5", 4050, 910, 1495, "success"],
  ["growth-agents", "ad-copy-gen", "DeepSeek", "deepseek-v3", 580, 220, 698, "success"],
  ["agents-platform", "agent-runner", "Anthropic", "claude-haiku-4.5", 1490, 295, 610, "success"],
];

const RATE: Record<string, number> = { OpenAI: 0.000006, Anthropic: 0.000008, Google: 0.0000035, DeepSeek: 0.0000015 };

export const USAGE_REQUESTS = USAGE_SEED.map((row, i) => {
  const [team, project, provider, model, tokensIn, tokensOut, latencyMs, status] = row;
  const cost = (tokensIn + tokensOut * 3) * (RATE[provider] || 0.000004);
  const minutesAgo = i * 6 + 2;
  return {
    id: `req_${(1000 + i).toString(36)}`,
    ts: minutesAgo < 60 ? `${minutesAgo}m ago` : `${Math.round(minutesAgo / 60)}h ago`,
    team, project, provider, model, tokensIn, tokensOut,
    cost: Number(cost.toFixed(5)),
    latencyMs, status,
  };
});

export function usageToCsv(rows: typeof USAGE_REQUESTS) {
  const header = "id,timestamp,team,project,provider,model,tokens_in,tokens_out,cost_usd,latency_ms,status";
  const lines = rows.map((r) => [r.id, r.ts, r.team, r.project, r.provider, r.model, r.tokensIn, r.tokensOut, r.cost, r.latencyMs, r.status].join(","));
  return [header, ...lines].join("\n");
}

export const BUDGET_POLICIES = [
  { id: 1, scope: "agents-platform", cap: 5000, spent: 5620, period: "monthly", thresholds: [75, 90, 100], action: "auto-throttle", status: "breached" },
  { id: 2, scope: "support-ai", cap: 6000, spent: 4820, period: "monthly", thresholds: [75, 90], action: "alert only", status: "warning" },
  { id: 3, scope: "doc-search", cap: 3000, spent: 1180, period: "monthly", thresholds: [80], action: "alert only", status: "ok" },
  { id: 4, scope: "internal-tools", cap: 2000, spent: 640, period: "monthly", thresholds: [90], action: "hard cap", status: "ok" },
  { id: 5, scope: "growth-agents", cap: 1500, spent: 420, period: "monthly", thresholds: [75, 90], action: "alert only", status: "ok" },
  { id: 6, scope: "workspace-wide", cap: 20000, spent: 12680, period: "monthly", thresholds: [80, 95], action: "alert + page oncall", status: "ok" },
];

export const BUDGET_ALERT_HISTORY = [
  { t: "2026-07-03 14:02", scope: "agents-platform", threshold: "100%", action: "auto-throttled to claude-haiku-4.5", sev: "breach" },
  { t: "2026-07-02 09:14", scope: "agents-platform", threshold: "90%", action: "Slack alert sent to #ai-spend", sev: "warn" },
  { t: "2026-07-01 22:40", scope: "support-ai", threshold: "75%", action: "Slack alert sent to #ai-spend", sev: "warn" },
  { t: "2026-06-29 11:05", scope: "workspace-wide", threshold: "80%", action: "email digest sent to admins", sev: "warn" },
  { t: "2026-06-24 16:51", scope: "internal-tools", threshold: "90%", action: "hard cap engaged for 6h, reset at cycle", sev: "breach" },
];

export const ROUTING_RULES = [
  { id: 1, name: "default — cheapest capable", priority: 1, type: "cost-based", candidates: ["claude-haiku-4.5", "gemini-2.5-flash", "gpt-4o-mini"], minQuality: 0.97, status: "active", fired24h: 8420 },
  { id: 2, name: "support-ai — low latency", priority: 2, type: "latency-based", candidates: ["gpt-4o-mini", "claude-haiku-4.5"], minQuality: 0.95, status: "active", fired24h: 3110 },
  { id: 3, name: "agents-platform — high reasoning", priority: 3, type: "policy-based", candidates: ["claude-sonnet-4.5", "gpt-4o"], minQuality: 0.99, status: "active", fired24h: 1860 },
  { id: 4, name: "fallback-on-outage — anthropic → openai", priority: 4, type: "fallback-on-outage", candidates: ["claude-haiku-4.5", "gpt-4o-mini"], minQuality: 0.90, status: "active", fired24h: 42 },
  { id: 5, name: "internal-tools — cost floor", priority: 5, type: "cost-based", candidates: ["deepseek-v3", "claude-haiku-4.5"], minQuality: 0.90, status: "paused", fired24h: 0 },
];

export const FEATURE_ATTRIBUTION = [
  { feature: "customer-support-bot", team: "support-ai", spend: 4820, taggedPct: 96, trend: [22, 28, 34, 30, 38, 46, 52] },
  { feature: "code-review-agent", team: "agents-platform", spend: 3260, taggedPct: 88, trend: [10, 14, 18, 22, 26, 30, 34] },
  { feature: "doc-qa-assistant", team: "doc-search", spend: 1180, taggedPct: 74, trend: [12, 14, 15, 16, 18, 17, 19] },
  { feature: "internal-copilot", team: "internal-tools", spend: 640, taggedPct: 61, trend: [8, 9, 8, 10, 9, 11, 10] },
  { feature: "untagged / unattributed", team: "—", spend: 3120, taggedPct: 0, trend: [14, 16, 15, 18, 17, 19, 20] },
];

export const TAG_COVERAGE = { taggedPct: 78, untaggedSpend: 3120, totalSpend: 12680 };

export const CHARGEBACK_LEDGER = [
  { costCenter: "CS-100 · Customer Support", team: "support-ai", spend: 4820, period: "June 2026" },
  { costCenter: "ENG-210 · Platform", team: "agents-platform", spend: 5620, period: "June 2026" },
  { costCenter: "ENG-220 · Search", team: "doc-search", spend: 1180, period: "June 2026" },
  { costCenter: "OPS-300 · Internal Tools", team: "internal-tools", spend: 640, period: "June 2026" },
  { costCenter: "MKT-410 · Growth", team: "growth-agents", spend: 420, period: "June 2026" },
];

export const CHARGEBACK_HISTORY = [
  { period: "June 2026", total: 12680, status: "in progress" },
  { period: "May 2026", total: 10940, status: "closed" },
  { period: "April 2026", total: 8420, status: "closed" },
  { period: "March 2026", total: 7110, status: "closed" },
];

export const UNIT_ECONOMICS_METRICS = [
  { id: 1, label: "Cost per conversation", feature: "customer-support-bot", value: 0.34, unit: "$", confidence: "measured", dataSource: "gateway + Zendesk", freshness: "live", trend: [0.52, 0.48, 0.44, 0.41, 0.38, 0.36, 0.34] },
  { id: 2, label: "Cost per PR reviewed", feature: "code-review-agent", value: 1.12, unit: "$", confidence: "measured", dataSource: "gateway + GitHub", freshness: "live", trend: [1.60, 1.48, 1.40, 1.30, 1.22, 1.18, 1.12] },
  { id: 3, label: "AI contribution to CAC", feature: "growth-agents", value: 3.80, unit: "$", confidence: "estimated", dataSource: "gateway + Google Analytics (partial)", freshness: "degraded", trend: [4.60, 4.40, 4.20, 4.05, 3.95, 3.88, 3.80] },
  { id: 4, label: "Cost per doc answered", feature: "doc-qa-assistant", value: 0.09, unit: "$", confidence: "estimated", dataSource: "gateway only — no CRM connected", freshness: "stale", trend: [0.12, 0.11, 0.11, 0.10, 0.10, 0.095, 0.09] },
];

export const CONNECTED_DATA_SOURCES = [
  { id: "gateway", name: "Tokenistt gateway", status: "live", lastSync: "just now" },
  { id: "zendesk", name: "Zendesk", status: "live", lastSync: "4m ago" },
  { id: "github", name: "GitHub", status: "live", lastSync: "9m ago" },
  { id: "ga", name: "Google Analytics", status: "degraded", lastSync: "6h ago" },
  { id: "crm", name: "CRM (Salesforce)", status: "not connected", lastSync: "—" },
];

export const FORECAST_HISTORICAL = [6200, 6800, 7400, 8100, 8420, 9100, 9800, 10200, 10940, 11400, 12000, 12680];
export const FORECAST_PROJECTED = [13200, 13850, 14500, 15100, 15780, 16400];
export const FORECAST_ACCURACY = [
  { period: "April 2026", forecast: 8700, actual: 8420, deltaPct: -3.2 },
  { period: "May 2026", forecast: 11100, actual: 10940, deltaPct: -1.4 },
  { period: "June 2026", forecast: 12300, actual: 12680, deltaPct: 3.1 },
];
export const FORECAST_SCENARIOS = [
  { id: 1, label: "Support bot launch — EU region", impact: "+$1,800/mo from August", addedBy: "R. Fernandez" },
  { id: 2, label: "Migrate agents-platform to haiku-4.5 default", impact: "−$1,200/mo from July", addedBy: "A. Tiwari" },
];

export const ROI_INITIATIVES = [
  { id: 1, name: "customer-support-bot", cost: 4820, value: 18400, marginPct: 73.8, trend: [40, 48, 55, 60, 66, 71, 74], confidence: "measured", valueModel: "hours saved × loaded support cost", atRisk: false },
  { id: 2, name: "code-review-agent", cost: 3260, value: 9100, marginPct: 64.2, trend: [30, 38, 44, 50, 56, 60, 64], confidence: "measured", valueModel: "reviewer hours saved", atRisk: false },
  { id: 3, name: "growth-agents (ad copy gen)", cost: 420, value: 610, marginPct: 31.1, trend: [55, 48, 42, 38, 34, 32, 31], confidence: "estimated", valueModel: "conversion uplift, partial GA data", atRisk: true },
  { id: 4, name: "internal-copilot", cost: 640, value: 720, marginPct: 11.1, trend: [30, 24, 20, 16, 13, 12, 11], confidence: "estimated", valueModel: "self-reported hours saved survey", atRisk: true },
];

export const MODEL_COMPARISON = [
  { model: "claude-haiku-4.5", provider: "Anthropic", taskType: "support-classification", cost: 0.0011, latency: 612, quality: 96, trend: [0.0018, 0.0016, 0.0014, 0.0013, 0.0012, 0.0011] },
  { model: "gpt-4o-mini", provider: "OpenAI", taskType: "support-classification", cost: 0.0021, latency: 780, quality: 94, trend: [0.0026, 0.0025, 0.0024, 0.0023, 0.0022, 0.0021] },
  { model: "gemini-2.5-flash", provider: "Google", taskType: "support-classification", cost: 0.0009, latency: 540, quality: 91, trend: [0.0013, 0.0012, 0.0011, 0.0010, 0.0009, 0.0009] },
  { model: "deepseek-v3", provider: "DeepSeek", taskType: "support-classification", cost: 0.0006, latency: 690, quality: 87, trend: [0.0009, 0.0008, 0.0008, 0.0007, 0.0007, 0.0006] },
];
export const MODEL_COMPARISON_RECOMMENDATION = {
  taskType: "support-classification",
  recommended: "claude-haiku-4.5",
  reasoning: "Highest quality score (96) at 2nd-lowest cost. gemini-2.5-flash is cheaper but 5pts lower quality — below the 95 min_quality bar set for this task.",
};

export const SIMULATOR_BASELINE = { spend: 12680, requests: 842000, avgLatency: 690, qualityScore: 95.2 };

export const BOARD_REPORT_TEMPLATES = [
  { id: 1, name: "Monthly spend summary", cadence: "monthly · 1st", lastSent: "2026-07-01", recipients: "board@company.com, finance@company.com", freshness: "live" },
  { id: 2, name: "Quarterly ROI review", cadence: "quarterly", lastSent: "2026-04-01", recipients: "board@company.com", freshness: "live" },
  { id: 3, name: "Budget & governance digest", cadence: "weekly · Mon 9am", lastSent: "2026-06-29", recipients: "#ai-spend (Slack)", freshness: "degraded" },
];

// Tokenistt-issued API keys — used by the onboarding walkthrough only.
export const API_KEYS = [
  { id: 1, name: "production / gateway", prefix: "tk_live_9f2a…c81e", created: "2026-04-02", lastUsed: "2m ago", scope: "read+write" },
];
