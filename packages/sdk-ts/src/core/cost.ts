import { Emitter } from './emitter';
import { BudgetExceededError } from './errors';

/**
 * A model's per-token price in USD, expressed **per 1,000,000 tokens**.
 * `output` covers generated tokens; `cachedInput` is optional and falls back
 * to `input` if omitted.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
}

export type PricingTable = Record<string, ModelPrice>;

export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface UsageEvent {
  cost: number;
  cumulativeCost: number;
  currency: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  user?: string;
  costCenter?: string;
  requestId?: string;
}

export interface BudgetEvent {
  cumulativeCost: number;
  limit: number;
  currency: string;
  user?: string;
  costCenter?: string;
}

export interface BudgetConfig {
  /** Emit `budget:warning` once cumulative spend reaches this amount. */
  softLimit?: number;
  /** Emit `budget:exceeded` (and, if enabled, block requests) at this amount. */
  hardLimit?: number;
  /** Fraction of `hardLimit` used as the warning threshold when `softLimit` is unset. Default 0.8. */
  warnAtFraction?: number;
}

export interface CostTrackerEvents {
  usage: UsageEvent;
  'budget:warning': BudgetEvent;
  'budget:exceeded': BudgetEvent;
}

/** Built-in, best-effort pricing (USD / 1M tokens). Override via `pricing`. */
const DEFAULT_PRICING: PricingTable = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-2024-08-06': { input: 2.5, output: 10 },
  'gpt-4o-2024-11-20': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4-turbo-2024-04-09': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-4-32k': { input: 60, output: 120 },
  'gpt-4-0125-preview': { input: 10, output: 30 },
  'gpt-4-1106-preview': { input: 10, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'gpt-3.5-turbo-0125': { input: 0.5, output: 1.5 },
  'gpt-3.5-turbo-instruct': { input: 1.5, output: 2 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-ada-002': { input: 0.1, output: 0 },
  o1: { input: 15, output: 60 },
  'o1-preview': { input: 15, output: 60 },
  'o1-mini': { input: 1.1, output: 4.4 },
  'o3-mini': { input: 1.1, output: 4.4 },
  // Anthropic Claude Models
  'claude-3-5-sonnet': { input: 3.0, output: 15.0, cachedInput: 0.3 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0, cachedInput: 0.3 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0, cachedInput: 0.08 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0, cachedInput: 0.08 },
  'claude-3-opus': { input: 15.0, output: 75.0 },
  'claude-3-opus-20240229': { input: 15.0, output: 75.0 },
  'claude-3-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-sonnet-20240229': { input: 3.0, output: 15.0 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
};

export function getDefaultPricing(): PricingTable {
  return { ...DEFAULT_PRICING };
}

function resolvePrice(model: string, pricing: PricingTable): ModelPrice {
  if (pricing[model]) return pricing[model];
  // Dated / quantized variants: pick the longest matching prefix.
  let best: ModelPrice | undefined;
  let bestLen = -1;
  for (const key of Object.keys(pricing)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = pricing[key];
      bestLen = key.length;
    }
  }
  return best ?? { input: 0, output: 0 };
}

export function computeCost(
  model: string,
  usage: UsageLike,
  pricing: PricingTable,
): number {
  const price = resolvePrice(model, pricing);
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const uncached = Math.max(0, promptTokens - cachedTokens);
  const cachedRate = price.cachedInput ?? price.input;

  const inCost = (uncached / 1e6) * price.input + (cachedTokens / 1e6) * cachedRate;
  const outCost = (completionTokens / 1e6) * price.output;
  return inCost + outCost;
}

export class CostTracker extends Emitter<CostTrackerEvents> {
  cumulative = 0;
  private warned = false;
  private exceeded = false;

  constructor(
    private opts: {
      pricing: PricingTable;
      budget?: BudgetConfig;
      onUsage?: (cost: number) => void;
      currency: string;
    },
  ) {
    super();
  }

  record(
    model: string,
    usage: UsageLike,
    meta: { user?: string; costCenter?: string; requestId?: string },
  ): UsageEvent {
    const cost = computeCost(model, usage, this.opts.pricing);
    this.cumulative += cost;

    const ev: UsageEvent = {
      cost,
      cumulativeCost: this.cumulative,
      currency: this.opts.currency,
      model,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
      user: meta.user,
      costCenter: meta.costCenter,
      requestId: meta.requestId,
    };

    this.opts.onUsage?.(cost);
    this.emitEvent('usage', ev);
    this.checkBudget(meta);

    return ev;
  }

  private checkBudget(meta: { user?: string; costCenter?: string }): void {
    const { softLimit, hardLimit, warnAtFraction = 0.8 } = this.opts.budget ?? {};
    const warnThreshold =
      softLimit ?? (hardLimit != null ? hardLimit * warnAtFraction : undefined);

    if (warnThreshold != null && this.cumulative >= warnThreshold && !this.warned) {
      this.warned = true;
      this.emitEvent('budget:warning', {
        cumulativeCost: this.cumulative,
        limit: warnThreshold,
        currency: this.opts.currency,
        user: meta.user,
        costCenter: meta.costCenter,
      });
    }

    if (hardLimit != null && this.cumulative >= hardLimit && !this.exceeded) {
      this.exceeded = true;
      this.emitEvent('budget:exceeded', {
        cumulativeCost: this.cumulative,
        limit: hardLimit,
        currency: this.opts.currency,
        user: meta.user,
        costCenter: meta.costCenter,
      });
    }
  }

  maybeThrowIfExceeded(meta: { user?: string; costCenter?: string }): void {
    const hardLimit = this.opts.budget?.hardLimit;
    if (hardLimit != null && this.cumulative >= hardLimit) {
      throw new BudgetExceededError(this.cumulative, hardLimit);
    }
  }
}
