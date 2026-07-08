// Shared types for the Shadow AI expense scanner.

export type ExpenseProvider = "brex" | "ramp" | "navan";
export type AiVendor = "openai" | "anthropic" | "perplexity" | "unknown";

export interface ExpenseTransaction {
  id: string;
  date: string; // ISO
  description: string;
  amount: number; // major units (USD)
  currency: string;
  vendor: string; // raw merchant
  employeeEmail?: string;
  source: ExpenseProvider;
  raw: Record<string, unknown>;
}

export interface ScannedExpense {
  transaction: ExpenseTransaction;
  vendor: AiVendor;
  keyword: string;
  employeeEmail?: string;
}

export interface OrgUserDir {
  email: string;
  actor: string; // gateway user id (X-Tokenistt-User)
  name?: string;
}

export interface OrgConfig {
  orgId: string;
  providers: ExpenseProvider[];
  users?: OrgUserDir[];
}

export interface ShadowFinding {
  id: string;
  detectedAt: string;
  source: "card-transaction" | "expense-report";
  vendor: string; // display label, e.g. "OpenAI"
  employeeEmail?: string;
  amountUsd: number;
  hasGatewayUsage: boolean; // false => personal account
  shadow: boolean; // !hasGatewayUsage
  apiSpendUsd: number; // corporate API spend for this actor/vendor
  trueCostUsd: number; // apiSpendUsd + expensed subscription
  note: string;
}

export interface ScanTotals {
  shadowSpendUsd: number;
  expensedUsd: number;
  apiSpendUsd: number;
  trueCostUsd: number;
  shadowCount: number;
}

export interface ScanResult {
  orgId: string;
  runAt: string;
  periodStart: string;
  periodEnd: string;
  findings: ShadowFinding[];
  totals: ScanTotals;
}
