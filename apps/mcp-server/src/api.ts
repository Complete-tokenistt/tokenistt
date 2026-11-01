import { DASHBOARD_URL, DASHBOARD_TOKEN } from "./config";

export class ApiError extends Error {}

/** GET JSON from the dashboard (which fronts the database and the gateway management API). */
export async function dash<T = any>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${DASHBOARD_URL.replace(/\/$/, "")}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) if (v) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: DASHBOARD_TOKEN ? { Authorization: `Bearer ${DASHBOARD_TOKEN}` } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e: any) {
    throw new ApiError(`Could not reach the Tokenistt dashboard at ${DASHBOARD_URL} (${e.message}). Is the stack running? Set TOKENISTT_DASHBOARD_URL if it is elsewhere.`);
  }
  if (res.status === 401) {
    throw new ApiError("The dashboard requires sign-in (AUTH_MODE=jwt). Set TOKENISTT_DASHBOARD_TOKEN to a session token.");
  }
  if (!res.ok) throw new ApiError(`Dashboard ${path} returned HTTP ${res.status}.`);
  return (await res.json()) as T;
}

export type ModelRow = {
  provider: string; model: string; requests: number;
  avg_cost_usd: number | null; avg_latency_ms: number | null; error_rate: number | null;
  input_per_1m: number | null; output_per_1m: number | null;
};

export const listModels = () => dash<ModelRow[]>("/api/gateway/models");

/** Match "gpt-4o" or "openai:gpt-4o" against the live catalog; prices are never guessed. */
export function findModel(models: ModelRow[], wanted: string): ModelRow | undefined {
  const w = wanted.toLowerCase();
  return models.find((m) => `${m.provider}:${m.model}`.toLowerCase() === w) ?? models.find((m) => m.model.toLowerCase() === w);
}

export const estimateUsd = (m: ModelRow, inTok: number, outTok: number): number | null =>
  m.input_per_1m == null || m.output_per_1m == null ? null : (inTok * m.input_per_1m + outTok * m.output_per_1m) / 1_000_000;

export const text = (t: string, data?: unknown) => ({
  content: [{ type: "text" as const, text: t }, ...(data === undefined ? [] : [{ type: "text" as const, text: JSON.stringify(data, null, 2) }])],
});
export const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});
