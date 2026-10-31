// Model catalog used by the cost/quality router. Mirrors the routing profiles
// in the Prompt 9 benchmarking UI. Swap for a live gateway catalog in prod.
export interface CatalogModel {
  id: string;
  label: string;
  costPerRequest: number; // USD
  quality: number; // 0..10
  accuracy: number; // 0..1
  latencyMs: number;
}

export const CATALOG: CatalogModel[] = [
  { id: "gpt-4o", label: "GPT-4o", costPerRequest: 0.012, quality: 8.7, accuracy: 0.91, latencyMs: 820 },
  { id: "claude-3-5-sonnet", label: "Claude Sonnet", costPerRequest: 0.009, quality: 8.9, accuracy: 0.89, latencyMs: 910 },
  { id: "gpt-4o-mini", label: "GPT-4o-mini", costPerRequest: 0.002, quality: 7.4, accuracy: 0.82, latencyMs: 410 },
  { id: "claude-3-haiku", label: "Haiku", costPerRequest: 0.0015, quality: 7.1, accuracy: 0.78, latencyMs: 350 },
  { id: "o1", label: "o1", costPerRequest: 0.05, quality: 9.2, accuracy: 0.95, latencyMs: 3200 },
];
