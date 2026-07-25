import { CATALOG, type CatalogModel } from "./catalog";

export interface RouteInput {
  prompt?: string;
  user?: string;
  maxCostUsd?: number;
  preferQuality?: boolean;
}

export interface RouteDecision {
  selectedModel: string;
  label: string;
  reason: string;
  estimatedCostUsd: number;
  estQuality: number;
}

// Picks the optimal model given cost/quality constraints.
export function route(input: RouteInput): RouteDecision {
  const max = input.maxCostUsd ?? Infinity;
  const affordable = CATALOG.filter((m) => m.costPerRequest <= max);
  const pool = affordable.length ? affordable : CATALOG; // fall back to all if none fit

  let pick: CatalogModel;
  if (input.preferQuality) {
    pick = [...pool].sort(
      (a, b) => b.quality - a.quality || a.costPerRequest - b.costPerRequest,
    )[0];
  } else {
    pick = [...pool].sort(
      (a, b) => b.quality / b.costPerRequest - a.quality / a.costPerRequest,
    )[0];
  }

  const reason = input.preferQuality
    ? `Highest quality (${pick.quality}/10) within budget; $${pick.costPerRequest.toFixed(4)}/req.`
    : `Best quality-per-cost ($${(pick.quality / pick.costPerRequest).toFixed(0)}/$) within budget; $${pick.costPerRequest.toFixed(4)}/req.`;

  return {
    selectedModel: pick.id,
    label: pick.label,
    reason,
    estimatedCostUsd: pick.costPerRequest,
    estQuality: pick.quality,
  };
}
