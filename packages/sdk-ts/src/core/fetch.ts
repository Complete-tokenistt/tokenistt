import type { Tokenistt } from '../client';
import { VERSION } from '../version';
import {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  makeErrorFromResponse,
} from './errors';

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  query?: Record<string, any> | null;
  body?: any;
  headers?: Record<string, string> | null;
  stream?: boolean;
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  /** Per-request attribution user (overrides the client default). */
  user?: string;
  /** Per-request cost-center override. */
  costCenter?: string;
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 60_000;

/**
 * Central request function: builds the URL + headers, performs the fetch with
 * automatic retries (exponential backoff + jitter, honoring `Retry-After`),
 * and emits `request` / `response` / `retry` events on the client.
 */
export async function httpRequest(client: Tokenistt, opts: RequestOptions): Promise<Response> {
  const maxRetries = opts.maxRetries ?? client.maxRetries;
  const timeout = opts.timeout ?? client.timeout;
  const fetchFn = client.fetchFn;
  const url = buildURL(client.baseURL, opts.path, opts.query, client.defaultQuery);
  const headers = buildHeaders(client, opts);

  let attempt = 0;
  let lastErr: unknown;
  let retryAfterMs: number | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ac = new AbortController();
    const timer =
      timeout > 0
        ? setTimeout(() => ac.abort(new APIConnectionTimeoutError({ requestId: client.requestId() })), timeout)
        : undefined;

    if (opts.signal) {
      if (opts.signal.aborted) throw new APIUserAbortError();
      opts.signal.addEventListener('abort', () => ac.abort(new APIUserAbortError()), { once: true });
    }

    const started = Date.now();
    client._emit('request', { method: opts.method, url, options: opts });

    try {
      const init: RequestInit = {
        method: opts.method,
        headers,
        signal: ac.signal,
        body:
          opts.body == null
            ? undefined
            : typeof opts.body === 'string'
              ? opts.body
              : JSON.stringify(opts.body),
      };

      const res = await fetchFn(url, init);
      if (timer) clearTimeout(timer);

      const resHeaders = headersToObj(res.headers);
      client._emit('response', {
        method: opts.method,
        url,
        status: res.status,
        headers: resHeaders,
        durationMs: Date.now() - started,
      });

      if (res.ok) return res;

      let errBody: unknown = null;
      try {
        errBody = await res.json().catch(() => null);
      } catch {
        /* ignore */
      }

      const apiErr = makeErrorFromResponse(res.status, errBody, resHeaders);
      lastErr = apiErr;

      const ra = res.headers.get('retry-after');
      retryAfterMs = ra ? parseRetryAfter(ra) : undefined;

      if (!shouldRetryStatus(res.status, attempt, maxRetries)) throw apiErr;
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err instanceof APIUserAbortError) throw err;
      // A non-retryable HTTP error response (401, 400, …) was already turned into a typed APIError above.
      if (err instanceof APIError) throw err;

      if (err instanceof APIConnectionTimeoutError) {
        lastErr = err;
      } else if (isAbortError(err)) {
        lastErr = new APIConnectionTimeoutError();
      } else {
        lastErr = new APIConnectionError({
          message: `Request to ${url} failed: ${(err as Error)?.message ?? String(err)}`,
          cause: err,
        });
      }

      if (!shouldRetryNetwork(attempt, maxRetries)) throw lastErr;
    }

    attempt += 1;
    if (attempt > maxRetries) throw lastErr;

    const delayMs = retryAfterMs ?? computeDelay(attempt);
    client._emit('retry', { attempt, delayMs, error: lastErr });
    await sleep(delayMs, opts.signal);
  }
}

function shouldRetryStatus(status: number, attempt: number, maxRetries: number): boolean {
  if (attempt >= maxRetries) return false;
  return RETRYABLE_STATUSES.has(status);
}

function shouldRetryNetwork(attempt: number, maxRetries: number): boolean {
  return attempt < maxRetries;
}

function computeDelay(attempt: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  const jitter = Math.random() * exp * 0.25;
  return Math.round(exp + jitter);
}

function parseRetryAfter(value: string): number | undefined {
  // Retry-After can be seconds (e.g. "30") or an HTTP date.
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.min(MAX_DELAY_MS, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.min(MAX_DELAY_MS, Math.max(0, date - Date.now()));
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new APIUserAbortError());
      },
      { once: true },
    );
  });
}

function buildURL(
  baseURL: string,
  path: string,
  query?: Record<string, any> | null,
  defaultQuery?: Record<string, any>,
): string {
  const url = new URL(baseURL + (path.startsWith('/') ? path : `/${path}`));
  const merged = { ...defaultQuery, ...query };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
    else if (typeof v === 'object') url.searchParams.append(k, JSON.stringify(v));
    else url.searchParams.append(k, String(v));
  }
  return url.toString();
}

function buildHeaders(client: Tokenistt, opts: RequestOptions): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${client.apiKey ?? ''}`,
    'X-Tokenistt-SDK-Version': VERSION,
    ...client.defaultHeaders,
    ...(opts.headers ?? {}),
  };

  const user = opts.user ?? client.user;
  const costCenter = opts.costCenter ?? client.costCenter;

  if (user) h['X-Tokenistt-User'] = user;
  if (costCenter) h['X-Tokenistt-Cost-Center'] = costCenter;
  if (client.organization) h['OpenAI-Organization'] = client.organization;
  if (client.project) h['OpenAI-Project'] = client.project;

  if (opts.body != null) h['Content-Type'] = 'application/json';

  return h;
}

function headersToObj(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException ||
    (err as Error)?.name === 'AbortError' ||
    (err as any)?.name === 'TimeoutError'
  );
}
