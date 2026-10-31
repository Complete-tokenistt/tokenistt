// Shared invoice-parsing helpers (used by the client uploader AND the
// server /api/reconciliation/upload route). Pure functions, no DOM/Node deps.

import type { InvoiceLine } from "./types";

export const KNOWN_PROVIDERS = [
  "openai",
  "anthropic",
  "bedrock",
  "google",
  "mistral",
  "other",
];

export function detectDelimiter(line: string): string {
  if (line.includes("\t")) return "\t";
  if (line.includes(";")) return ";";
  return ",";
}

// Tolerant CSV parser: maps common header names to our InvoiceLine shape.
export function parseCsv(text: string): InvoiceLine[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const delim = detectDelimiter(lines[0]);
  const headers = lines[0].split(delim).map((h) => h.trim().toLowerCase());

  const idx = (...keys: string[]) =>
    headers.findIndex((h) => keys.some((k) => h.includes(k)));

  const iProvider = idx("provider", "vendor");
  const iPeriod = idx("period", "month", "date");
  const iBilled = idx("billed", "amount", "total", "cost");
  const iCurrency = idx("currency", "ccy");

  return lines.slice(1).map((line) => {
    const cols = line.split(delim).map((c) => c.trim());
    const num = (s: string) =>
      parseFloat((s || "0").replace(/[^0-9.\-]/g, "")) || 0;
    return {
      provider: (cols[iProvider] || "other").toLowerCase(),
      period: cols[iPeriod] || "2026-07",
      billedUsd: num(cols[iBilled]),
      currency: cols[iCurrency] || "USD",
    };
  });
}

// Best-effort extraction of invoice line items from raw PDF text.
// Looks for a known provider name on a line that also contains a $ amount.
// NOTE: real vendor PDFs vary widely — tune this (or use a hosted OCR/parser)
// for production. This is enough to demo the upload → reconcile flow.
export function extractInvoicesFromText(text: string): InvoiceLine[] {
  const lines = text.split(/\r?\n/);
  const byProvider = new Map<string, number>();

  for (const line of lines) {
    const lower = line.toLowerCase();
    const prov = KNOWN_PROVIDERS.find(
      (p) => p !== "other" && lower.includes(p),
    );
    if (!prov) continue;
    const m = line.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
    if (!m) continue;
    const amt = parseFloat(m[1].replace(/,/g, "")) || 0;
    byProvider.set(prov, (byProvider.get(prov) ?? 0) + amt);
  }

  return [...byProvider.entries()].map(([provider, billedUsd]) => ({
    provider,
    period: "2026-07",
    billedUsd,
    currency: "USD",
  }));
}
