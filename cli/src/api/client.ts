/**
 * HTTP client for the Tokenistt gateway.
 *
 * - Three credential modes: management (`token` Bearer JWT, or `X-Admin-Secret` + org id) for /v1/admin/*,
 *   the virtual `apiKey` for /v1/ingest and /v1/usage/me, and none for /health.
 * - Retries with exponential backoff + jitter on network failures and 429/502/503/504, but only for
 *   requests that are safe to repeat (GET, or `idempotent: true` such as ingest keyed by event_id).
 * - Errors are mapped to typed CliErrors with a hint; credentials are scrubbed from every message.
 */
import { ApiError, AuthError, CliError, NetworkError } from '../core/errors.js';
import { redactText } from '../core/redact.js';
import type { ResolvedConfig } from '../config/store.js';

export type AuthMode = 'management' | 'key' | 'none';

export interface RequestOptions {
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  /** Safe to retry even though the method is not GET (the server de-duplicates). */
  idempotent?: boolean;
  /** Return the raw text body instead of parsing JSON (CSV exports). */
  text?: boolean;
  timeoutMs?: number;
}

export interface ClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  userAgent?: string;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ApiClient {
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(private readonly cfg: Pick<ResolvedConfig, 'apiUrl' | 'token' | 'adminSecret' | 'organizationId' | 'apiKey'>, private readonly opts: ClientOptions = {}) {
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 300;
    this.sleep = opts.sleep ?? realSleep;
    this.log = opts.log ?? (() => {});
  }

  get baseUrl(): string {
    return this.cfg.apiUrl;
  }
  get hasManagementCredentials(): boolean {
    return !!this.cfg.token || (!!this.cfg.adminSecret && !!this.cfg.organizationId);
  }
  get hasKey(): boolean {
    return !!this.cfg.apiKey;
  }

  private headers(mode: AuthMode): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', 'user-agent': this.opts.userAgent ?? 'tokenistt-cli' };
    if (mode === 'management') {
      if (this.cfg.token) h.authorization = `Bearer ${this.cfg.token}`;
      else if (this.cfg.adminSecret && this.cfg.organizationId) {
        h['x-admin-secret'] = this.cfg.adminSecret;
        h['x-organization-id'] = this.cfg.organizationId;
      } else {
        throw new AuthError('No management credentials are configured.', 'Run `tokenistt login` with a dashboard token or an operator admin secret + organization id.');
      }
    } else if (mode === 'key') {
      if (!this.cfg.apiKey) throw new AuthError('No Tokenistt API key is configured.', 'Run `tokenistt login` and provide a virtual key (tktt_live_…), or set TOKENISTT_API_KEY.');
      h.authorization = `Bearer ${this.cfg.apiKey}`;
    }
    return h;
  }

  async request<T = unknown>(mode: AuthMode, method: string, path: string, o: RequestOptions = {}): Promise<T> {
    const url = new URL(this.cfg.apiUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = this.headers(mode);
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const canRetry = method === 'GET' || o.idempotent === true;
    const attempts = canRetry ? this.maxAttempts : 1;

    let lastNetworkError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.log(`${method} ${url.pathname}${url.search} (attempt ${attempt}/${attempts})`);
      let res: Response;
      try {
        res = await this.f(url, {
          method,
          headers,
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
          signal: AbortSignal.timeout(o.timeoutMs ?? this.timeoutMs),
        });
      } catch (err) {
        lastNetworkError = err;
        if (attempt < attempts) {
          await this.sleep(this.delay(attempt));
          continue;
        }
        break;
      }

      if (res.ok) {
        this.log(`  → ${res.status}`);
        if (o.text) return (await res.text()) as T;
        const text = await res.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new CliError(`The server at ${this.cfg.apiUrl} returned a non-JSON response for ${path}.`, 1, 'Is TOKENISTT_API_URL pointing at the gateway (not the dashboard)?');
        }
      }

      if (RETRYABLE.has(res.status) && attempt < attempts) {
        const wait = this.retryAfterMs(res) ?? this.delay(attempt);
        this.log(`  → ${res.status}, retrying in ${wait}ms`);
        await this.sleep(wait);
        continue;
      }
      throw await this.toError(res, path);
    }

    const reason = lastNetworkError instanceof Error ? lastNetworkError.message : 'unknown error';
    throw new NetworkError(
      redactText(`Could not reach the Tokenistt gateway at ${this.cfg.apiUrl} (${reason}).`),
      'Check that the gateway is running and TOKENISTT_API_URL is correct. Telemetry queued locally is kept and will sync when it is reachable.',
    );
  }

  get = <T = unknown>(mode: AuthMode, path: string, o?: RequestOptions) => this.request<T>(mode, 'GET', path, o);
  post = <T = unknown>(mode: AuthMode, path: string, body?: unknown, o: RequestOptions = {}) => this.request<T>(mode, 'POST', path, { ...o, body });

  private delay(attempt: number): number {
    const exp = Math.min(30_000, this.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exp + Math.random() * exp * 0.25);
  }

  private retryAfterMs(res: Response): number | undefined {
    const v = res.headers.get('retry-after');
    if (!v) return undefined;
    const s = Number(v);
    return Number.isFinite(s) ? Math.min(30_000, s * 1000) : undefined;
  }

  private async toError(res: Response, path: string): Promise<CliError> {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* body is not JSON */
    }
    message = redactText(message);
    if (res.status === 401) return new AuthError(`The gateway rejected the credentials: ${message}`, 'Run `tokenistt login` again; dashboard tokens expire.');
    if (res.status === 403) return new ApiError(`Not allowed: ${message}`, 403, 'Your role lacks permission for this action. `tokenistt auth whoami` shows your role.');
    if (res.status === 404) return new ApiError(`Not found: ${path} (${message})`, 404, 'The gateway may be older than this CLI and missing this endpoint.');
    if (res.status === 429) return new ApiError(`Rate limited: ${message}`, 429, 'Wait a moment and try again.');
    return new ApiError(`The gateway returned an error: ${message}`, res.status);
  }
}
