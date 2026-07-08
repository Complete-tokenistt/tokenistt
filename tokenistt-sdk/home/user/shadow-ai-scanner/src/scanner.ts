import type { AiVendor, ExpenseTransaction, ScannedExpense } from "./types";

const RULES: { vendor: AiVendor; patterns: RegExp[] }[] = [
  { vendor: "openai", patterns: [/openai/i, /chatgpt/i, /chat\.?gpt/i] },
  { vendor: "anthropic", patterns: [/anthropic/i, /claude/i] },
  { vendor: "perplexity", patterns: [/perplexity/i] },
];

const VENDOR_LABEL: Record<AiVendor, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  perplexity: "Perplexity",
  unknown: "Unknown",
};

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

// Scan an expense description + merchant for known AI vendors.
export function scanExpense(tx: ExpenseTransaction): ScannedExpense | null {
  const hay = `${tx.description} ${tx.vendor}`;
  for (const r of RULES) {
    if (r.patterns.some((p) => p.test(hay))) {
      const email = tx.employeeEmail ?? hay.match(EMAIL_RE)?.[0];
      return { transaction: tx, vendor: r.vendor, keyword: r.patterns[0].source, employeeEmail: email };
    }
  }
  return null;
}

export function vendorLabel(v: AiVendor): string {
  return VENDOR_LABEL[v];
}

export const AI_VENDORS = RULES.map((r) => r.vendor);
