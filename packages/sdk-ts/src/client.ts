import { Emitter } from './core/emitter';
import { APIUserAbortError, BudgetExceededError, TokenisttError } from './core/errors';
import { CostTracker, getDefaultPricing, PricingTable, BudgetConfig } from './core/cost';
import { httpRequest, RequestOptions } from './core/fetch';
import { Chat } from './resources/chat';
import { Completions } from './resources/completions';
import { Embeddings } from './resources/embeddings';
import { Models } from './resources/models';
import { Moderations } from './resources/moderations';
import type { UsageEvent, BudgetEvent, UsageLike } from './core/cost';

export { BudgetConfig, PricingTable } from './core/cost';
export type { UsageEvent, BudgetEvent } from './core/cost';

// The self-hosted gateway; override with `baseURL` or the TOKENISTT_BASE_URL environment variable.
const DEFAULT_BASE_URL = 'http://localhost:3000/v1';
const env = (k: string): string | undefined => (typeof process !== 'undefined' ? process.env?.[k] : undefined);

/** Response of `GET /v1/usage/me`. */
export interface KeyUsage {
  key: { name: string; prefix: string };
  today: { requests: number; cost_usd: number };
  month: { requests: number; cost_usd: number; errors: number };
  last_request_at: string | null;
  budget: { cap_usd: number; period: 'daily' | 'monthly'; spent_usd: number; remaining_usd: number; percent_used: number } | null;
  top_models: { provider: string; model: string; requests: number; cost_usd: number }[];
}

export interface Attribution {
  team?: string;
  project?: string;
  environment?: string;
  repo?: string;
  ticket?: string;
  sprint?: string;
  feature?: string;
  customer?: string;
  employee?: string;
}

/** Header map for gateway features (`x-tokenistt-*`). Exported for per-request `headers`. */
export function gatewayHeaders(opts: { attribution?: Attribution; cache?: boolean | 'always'; compress?: boolean }): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.attribution ?? {})) {
    if (v) h[`x-tokenistt-${k}`] = String(v);
  }
  if (opts.cache) h['x-tokenistt-cache'] = opts.cache === 'always' ? 'always' : 'true';
  if (opts.compress) h['x-tokenistt-compress'] = 'true';
  return h;
}

export interface TokenisttOptions {
  /** Gateway API key (sent as `Authorization: Bearer`). */
  apiKey?: string;
  /** Gateway base URL. Defaults to the Tokenistt hosted gateway. */
  baseURL?: string;
  /** OpenAI-compatible organization header (forwarded to the gateway). */
  organization?: string;
  /** OpenAI-compatible project header (forwarded to the gateway). */
  project?: string;

  /** Default attribution user for *every* request. */
  user?: string;
  /** Default cost-center for *every* request (overridable per request). */
  costCenter?: string;

  /**
   * Attribution sent as `x-tokenistt-*` headers on every request, so spend can be broken
   * down by team, project, repo, ticket, sprint, feature, customer or employee.
   */
  attribution?: Attribution;
  /** Opt in to the gateway's response cache for identical requests ("true" | "always"). */
  cache?: boolean | 'always';
  /** Opt in to gateway-side prompt whitespace compression. */
  compress?: boolean;

  /** Per-request timeout in ms (default 600000). */
  timeout?: number;
  /** Max automatic retries (default 3). */
  maxRetries?: number;

  /** Override the built-in pricing table (USD / 1M tokens). */
  pricing?: PricingTable;
  /** Budget configuration for warnings / hard stops. */
  budget?: BudgetConfig;
  /** Called with the per-request cost (USD) after every billable response. */
  onUsage?: (cost: number) => void;
  /** If true, throw `BudgetExceededError` before sending a request once the hard limit is hit. */
  throwOnBudgetExceeded?: boolean;
  /** ISO currency code shown in events (default "USD"). */
  currency?: string;

  /** Inject a custom fetch implementation (logging, proxying, tests). */
  fetch?: typeof fetch;
  defaultHeaders?: Record<string, string>;
  defaultQuery?: Record<string, any>;

  /** Required to run in a browser; intentionally not enabled by default. */
  dangerouslyAllowBrowser?: boolean;
}

export interface ClientEvents {
  request: { method: string; url: string; options: RequestOptions };
  response: {
    method: string;
    url: string;
    status: number;
    headers: Record<string, string>;
    durationMs: number;
  };
  retry: { attempt: number; delayMs: number; error?: unknown };
  usage: UsageEvent;
  'budget:warning': BudgetEvent;
  'budget:exceeded': BudgetEvent;
}

/**
 * Drop-in replacement for the `openai` client that routes to the Tokenistt
 * gateway. Mirrors `openai@4.x` constructor + resource layout, and adds
 * attribution, cost tracking, and budget control.
 */
export class Tokenistt extends Emitter<ClientEvents> {
  readonly apiKey?: string;
  readonly baseURL: string;
  readonly organization?: string;
  readonly project?: string;
  readonly user?: string;
  readonly costCenter?: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly fetchFn: typeof fetch;
  readonly defaultHeaders: Record<string, string>;
  readonly defaultQuery: Record<string, any>;
  readonly currency: string;

  readonly chat: Chat;
  readonly embeddings: Embeddings;
  readonly models: Models;
  readonly moderations: Moderations;
  readonly completions: Completions;

  protected tracker: CostTracker;
  protected throwOnBudgetExceeded: boolean;
  #requestCounter = 0;

  constructor(opts: TokenisttOptions = {}) {
    super();

    if (typeof window !== 'undefined' && !opts.dangerouslyAllowBrowser) {
      throw new TokenisttError(
        'It looks like you are running in a browser. The Tokenistt SDK is ' +
          'server-side only by default. If you understand the risks, pass ' +
          '{ dangerouslyAllowBrowser: true }.',
      );
    }

    this.apiKey = opts.apiKey ?? env('TOKENISTT_API_KEY');
    this.baseURL = (opts.baseURL ?? env('TOKENISTT_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.organization = opts.organization;
    this.project = opts.project;
    this.user = opts.user;
    this.costCenter = opts.costCenter;
    this.timeout = opts.timeout ?? 600_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchFn = opts.fetch ?? (globalThis.fetch as typeof fetch);
    if (!this.fetchFn) {
      throw new TokenisttError(
        'global fetch is unavailable. Use Node >= 18, or pass a `fetch` implementation.',
      );
    }
    this.defaultHeaders = { ...gatewayHeaders(opts), ...(opts.defaultHeaders ?? {}) };
    this.defaultQuery = opts.defaultQuery ?? {};
    this.currency = opts.currency ?? 'USD';
    this.throwOnBudgetExceeded = opts.throwOnBudgetExceeded ?? false;

    this.tracker = new CostTracker({
      pricing: opts.pricing ?? getDefaultPricing(),
      budget: opts.budget,
      onUsage: opts.onUsage,
      currency: this.currency,
    });

    // Forward tracker events to the public client emitter.
    this.tracker.on('usage', (e) => this._emit('usage', e));
    this.tracker.on('budget:warning', (e) => this._emit('budget:warning', e));
    this.tracker.on('budget:exceeded', (e) => this._emit('budget:exceeded', e));

    this.chat = new Chat(this);
    this.embeddings = new Embeddings(this);
    this.models = new Models(this);
    this.moderations = new Moderations(this);
    this.completions = new Completions(this);
  }

  /** Internal: emit a client-level event. */
  _emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    super.emitEvent(event, payload);
  }

  /** Monotonic request id (also surfaced via `requestId()`). */
  requestId(): string {
    return `tk_${++this.#requestCounter}`;
  }

  /** Record usage for a billable response and fire cost/budget events. */
  recordUsage(
    usage: UsageLike | undefined,
    meta: { model: string; user?: string; costCenter?: string; requestId?: string },
  ): void {
    if (!usage) return;
    this.tracker.record(meta.model, usage, {
      user: meta.user ?? this.user,
      costCenter: meta.costCenter ?? this.costCenter,
      requestId: meta.requestId,
    });
  }

  /** What this API key has spent on the gateway (today, this month, top models, budget headroom). */
  async usage(): Promise<KeyUsage> {
    const res = await this.request({ method: 'GET', path: '/usage/me' });
    return (await res.json()) as KeyUsage;
  }

  /** Total tracked spend across this client instance, in `currency`. */
  getCumulativeCost(): number {
    return this.tracker.cumulative;
  }

  /**
   * Low-level request primitive. Most users call resource methods
   * (`client.chat.completions.create(...)`) instead.
   */
  async request(opts: RequestOptions): Promise<Response> {
    if (this.throwOnBudgetExceeded) {
      this.tracker.maybeThrowIfExceeded({
        user: opts.user ?? this.user,
        costCenter: opts.costCenter ?? this.costCenter,
      });
    }
    try {
      return await httpRequest(this, opts);
    } catch (err) {
      if (err instanceof APIUserAbortError) throw err;
      throw err;
    }
  }
}
