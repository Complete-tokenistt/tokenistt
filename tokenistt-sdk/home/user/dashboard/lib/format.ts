// Small formatting + presentation helpers shared across the dashboard.

import type { ModelTier } from "./types";

export const fmtUsd = (n: number, maxFrac = 0): string =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: maxFrac,
  });

export const fmtUsdCompact = (n: number): string => {
  if (Math.abs(n) >= 1_000_000)
    return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return fmtUsd(n);
};

export const fmtPct = (n: number, withSign = true): string => {
  const sign = withSign && n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
};

export const fmtNumber = (n: number): string =>
  n.toLocaleString("en-US");

export const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// Provider brand colors used by charts + badges.
export const PROVIDER_COLORS: Record<string, string> = {
  openai: "#10a37f",
  anthropic: "#d97757",
  bedrock: "#ff9900",
  google: "#4285f4",
  mistral: "#ff7000",
  other: "#94a3b8",
};

export const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "AWS Bedrock",
  google: "Google AI",
  mistral: "Mistral",
  other: "Other",
};

export function statusTone(status: string): string {
  switch (status) {
    case "critical":
    case "over-billed":
    case "high":
    case "unreviewed":
      return "bg-red-100 text-red-700 ring-red-200";
    case "warning":
    case "under-billed":
    case "medium":
    case "acknowledged":
      return "bg-amber-100 text-amber-700 ring-amber-200";
    case "matched":
    case "ok":
    case "approved":
    case "low":
      return "bg-emerald-100 text-emerald-700 ring-emerald-200";
    case "missing":
      return "bg-slate-100 text-slate-600 ring-slate-200";
    default:
      return "bg-slate-100 text-slate-600 ring-slate-200";
  }
}

// Model metadata: tier (expensive -> cheap) + brand-ish colors for charts.
export const MODEL_TIERS: Record<string, ModelTier> = {
  "gpt-4o": "frontier",
  o1: "frontier",
  "o3-mini": "frontier",
  "claude-3-opus": "frontier",
  "claude-3-5-sonnet": "standard",
  "gpt-4o-mini": "cheap",
  "claude-3-haiku": "cheap",
};

export const MODEL_LABELS: Record<string, string> = {
  "gpt-4o": "GPT-4o",
  o1: "o1",
  "o3-mini": "o3-mini",
  "claude-3-opus": "Claude Opus",
  "claude-3-5-sonnet": "Claude Sonnet",
  "gpt-4o-mini": "GPT-4o-mini",
  "claude-3-haiku": "Haiku",
};

export const MODEL_COLORS: Record<string, string> = {
  "gpt-4o": "#ef4444",
  o1: "#dc2626",
  "o3-mini": "#f97316",
  "claude-3-opus": "#b91c1c",
  "claude-3-5-sonnet": "#f59e0b",
  "gpt-4o-mini": "#10b981",
  "claude-3-haiku": "#14b8a6",
};

export const TIER_TONE: Record<ModelTier, string> = {
  frontier: "bg-red-100 text-red-700 ring-red-200",
  standard: "bg-amber-100 text-amber-700 ring-amber-200",
  cheap: "bg-emerald-100 text-emerald-700 ring-emerald-200",
};

export const TIER_LABEL: Record<ModelTier, string> = {
  frontier: "Expensive",
  standard: "Standard",
  cheap: "Cheap",
};
