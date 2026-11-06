/**
 * Rules over real usage. It only suggests, never applies anything. A savings figure appears only when both models have
 * catalog prices, and it is a range because swapping a model changes quality and token counts too. No prices are built in.
 */
export interface UsageRow {
  key: string | null;
  requests: number;
  input_tokens: string;
  output_tokens: string;
  cached_tokens: string;
  cost_usd: string;
  errors: number;
  zero_cost_requests: number;
}

export interface ModelInfo {
  provider: string;
  model: string;
  input_per_1m: number | null;
  output_per_1m: number | null;
}

export interface Finding {
  rule: string;
  title: string;
  evidence: string;
  suggestion: string;
  tradeoff: string;
  confidence: 'high' | 'medium' | 'low';
  savingsUsd?: { low: number; high: number };
}

const MIN_REQUESTS = 20;
const usd = (n: number): string => `$${n.toFixed(2)}`;
const perToken = (m: ModelInfo): number | null => (m.input_per_1m === null || m.output_per_1m === null ? null : m.input_per_1m + m.output_per_1m);

export function findOptimizations(rows: UsageRow[], models: ModelInfo[]): Finding[] {
  const out: Finding[] = [];
  const total = rows.reduce((t, r) => t + Number(r.cost_usd), 0);
  const byName = new Map(models.map((m) => [m.model, m]));

  for (const r of rows) {
    if (!r.key) continue;
    const name = r.key;
    const cost = Number(r.cost_usd);
    const input = Number(r.input_tokens);
    const cached = Number(r.cached_tokens);

    if (r.zero_cost_requests > 0) {
      out.push({
        rule: 'missing-price', title: `${name} has no catalog price`, evidence: `${r.zero_cost_requests} of ${r.requests} requests recorded $0.00 despite using tokens.`,
        suggestion: 'Add a price to the catalog so its spend is visible.', tradeoff: 'None. Until then, total spend is understated.', confidence: 'high',
      });
    }
    if (r.requests >= MIN_REQUESTS && r.errors / r.requests >= 0.1) {
      out.push({
        rule: 'high-errors', title: `${name} fails ${Math.round((r.errors / r.requests) * 100)}% of the time`, evidence: `${r.errors} errors in ${r.requests} requests.`,
        suggestion: 'Look at the failing requests, and consider a fallback route.', tradeoff: 'A fallback model may behave differently.', confidence: 'high',
      });
    }
    if (r.requests >= MIN_REQUESTS && input > 0 && cached / (input + cached) < 0.05 && input / r.requests >= 2000) {
      out.push({
        rule: 'no-caching', title: `${name} sends large prompts with almost no caching`, evidence: `About ${Math.round(input / r.requests).toLocaleString('en-US')} input tokens per request, ${Math.round((cached / (input + cached)) * 100)}% cached.`,
        suggestion: 'If prompts share a long prefix, turn on prompt caching.', tradeoff: 'Only helps if prompts really repeat, which these numbers cannot show.', confidence: 'low',
      });
    }
    const current = byName.get(name);
    const currentRate = current ? perToken(current) : null;
    if (current && currentRate !== null && r.requests >= MIN_REQUESTS && total > 0 && cost / total >= 0.1) {
      const cheaper = models.filter((m) => m.provider === current.provider && m.model !== name && (perToken(m) ?? Infinity) < currentRate * 0.6).sort((a, b) => (perToken(b) ?? 0) - (perToken(a) ?? 0))[0];
      const cheaperRate = cheaper ? perToken(cheaper) : null;
      if (cheaper && cheaperRate !== null) {
        const full = cost * (1 - cheaperRate / currentRate);
        out.push({
          rule: 'cheaper-model', title: `Some ${name} traffic might suit ${cheaper.model}`, evidence: `${name} is ${Math.round((cost / total) * 100)}% of spend (${usd(cost)}), and ${cheaper.model} lists at ${Math.round((cheaperRate / currentRate) * 100)}% of its price.`,
          suggestion: 'Try it on a sample of requests that do not need the larger model.', tradeoff: 'Quality may drop. Nothing here measures quality, so test before moving traffic.', confidence: 'medium',
          // Assumes between a quarter and three quarters of the traffic could move.
          savingsUsd: { low: full * 0.25, high: full * 0.75 },
        });
      }
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.confidence] - order[b.confidence] || (b.savingsUsd?.high ?? 0) - (a.savingsUsd?.high ?? 0));
}
