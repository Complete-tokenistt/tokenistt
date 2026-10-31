/**
 * services/circuitBreaker.ts — per-provider circuit breaker.
 *
 * closed    → requests flow; failures are counted in a rolling window
 * open      → provider is skipped for `cooldownMs` after `threshold` failures
 * half-open → after the cooldown a single trial request is allowed; success closes
 *             the circuit, failure re-opens it
 *
 * Only provider-side failures (5xx / timeouts / rate limits) should be recorded —
 * never client errors.
 */
export type BreakerState = 'closed' | 'open' | 'half-open';

interface Entry {
  failures: number[];        // timestamps within the window
  openedAt: number | null;
  trialInFlight: boolean;
}

export class CircuitBreaker {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly threshold = parseInt(process.env.BREAKER_THRESHOLD || '5', 10),
    private readonly windowMs = parseInt(process.env.BREAKER_WINDOW_MS || '30000', 10),
    private readonly cooldownMs = parseInt(process.env.BREAKER_COOLDOWN_MS || '30000', 10),
    private readonly now: () => number = Date.now
  ) {}

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { failures: [], openedAt: null, trialInFlight: false };
      this.entries.set(key, e);
    }
    return e;
  }

  state(key: string): BreakerState {
    const e = this.entry(key);
    if (e.openedAt === null) return 'closed';
    return this.now() - e.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }

  /** True if a request may be sent now. In half-open state exactly one trial is admitted. */
  allow(key: string): boolean {
    const s = this.state(key);
    if (s === 'closed') return true;
    if (s === 'open') return false;
    const e = this.entry(key);
    if (e.trialInFlight) return false;
    e.trialInFlight = true;
    return true;
  }

  success(key: string): void {
    const e = this.entry(key);
    e.failures = [];
    e.openedAt = null;
    e.trialInFlight = false;
  }

  failure(key: string): void {
    const e = this.entry(key);
    const t = this.now();
    e.trialInFlight = false;
    if (e.openedAt !== null) {        // failed trial → re-open
      e.openedAt = t;
      return;
    }
    e.failures = e.failures.filter(ts => t - ts < this.windowMs);
    e.failures.push(t);
    if (e.failures.length >= this.threshold) e.openedAt = t;
  }

  snapshot(): Record<string, BreakerState> {
    return Object.fromEntries([...this.entries.keys()].map(k => [k, this.state(k)]));
  }
}

export const providerBreaker = new CircuitBreaker();
