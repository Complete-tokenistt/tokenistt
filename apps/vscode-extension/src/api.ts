// Talks to the Tokenistt gateway with the developer's own API key. No `vscode` import: unit-testable.

export interface KeyUsage {
  key: { name: string; prefix: string };
  today: { requests: number; cost_usd: number };
  month: { requests: number; cost_usd: number; errors: number };
  last_request_at: string | null;
  budget: { cap_usd: number; period: 'daily' | 'monthly'; spent_usd: number; remaining_usd: number; percent_used: number } | null;
  top_models: { provider: string; model: string; requests: number; cost_usd: number }[];
}

export interface RequestRow {
  id: string;
  request_id: string | null;
  provider: string;
  model: string;
  cost_usd: string;
  prompt_tokens: number;
  completion_tokens: number;
  status: string;
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
}

export class GatewayError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'unreachable' | 'server') {
    super(message);
  }
}

async function get<T>(gatewayUrl: string, path: string, apiKey: string): Promise<T> {
  const base = gatewayUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/v1${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e: any) {
    throw new GatewayError(`Cannot reach the gateway at ${base} (${e?.cause?.code ?? e?.message ?? 'network error'}).`, 'unreachable');
  }
  if (res.status === 401 || res.status === 403) {
    throw new GatewayError('The gateway rejected this API key (invalid or revoked).', 'auth');
  }
  if (!res.ok) throw new GatewayError(`Gateway returned HTTP ${res.status}.`, 'server');
  return (await res.json()) as T;
}

export const fetchUsage = (gatewayUrl: string, apiKey: string) => get<KeyUsage>(gatewayUrl, '/usage/me', apiKey);

export async function fetchRecent(gatewayUrl: string, apiKey: string, limit = 15): Promise<RequestRow[]> {
  return (await get<{ data: RequestRow[] }>(gatewayUrl, `/logs?limit=${limit}`, apiKey)).data;
}
