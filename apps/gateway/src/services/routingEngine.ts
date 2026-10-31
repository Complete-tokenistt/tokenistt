/**
 * services/routingEngine.ts — rule-driven provider/model selection.
 *
 * Rules live in `routing_rules` (per organization, evaluated by ascending priority).
 * The first enabled rule whose `match` fits the request decides the candidate list:
 *
 *   fallback  targets are tried in the order given
 *   cheapest  targets ordered by estimated request cost (price catalog)
 *   fastest   targets ordered by observed average latency (last 24h of the ledger)
 *   policy    targets in order, restricted to providers the key is allowed to use
 *
 * With no matching rule the router keeps its default behaviour (model → provider
 * detection plus the configured failover chain), so routing is strictly opt-in.
 */
import { getPool } from '../db/pool.js';
import type { AuthContext } from '../db/auth.js';
import type { OpenAIChatCompletionRequest } from '../types/index.js';
import { estimateRequestTokens } from '../providers/base.js';
import { calculateCost } from './pricing.js';
import { logDecision } from './auditLogger.js';

export type Strategy = 'cheapest' | 'fastest' | 'policy' | 'fallback';

export interface RouteTarget {
  provider: string;
  model: string;
}

export interface RoutingRule {
  id: string;
  name: string;
  priority: number;
  strategy: Strategy;
  match: {
    model?: string;          // substring match on requested model
    cost_center?: string;
    team_id?: string;
    project_id?: string;
  };
  targets: RouteTarget[];
}

export interface RouteDecision {
  rule: RoutingRule;
  strategy: Strategy;
  candidates: RouteTarget[];
}

// ── rule cache ───────────────────────────────────────────────────────────────

const RULE_TTL_MS = 30_000;
const ruleCache = new Map<string, { at: number; rules: RoutingRule[] }>();

export function clearRoutingCache(): void {
  ruleCache.clear();
  latencyCache = null;
}

export async function loadRules(orgId: bigint): Promise<RoutingRule[]> {
  const key = orgId.toString();
  const hit = ruleCache.get(key);
  if (hit && Date.now() - hit.at < RULE_TTL_MS) return hit.rules;

  const { rows } = await getPool().query(
    `SELECT public_id::text AS id, name, priority, strategy, match, targets
       FROM routing_rules
      WHERE organization_id = $1 AND is_enabled = true
      ORDER BY priority ASC, id ASC`,
    [key]
  );
  ruleCache.set(key, { at: Date.now(), rules: rows });
  return rows;
}

// ── matching ─────────────────────────────────────────────────────────────────

export function ruleMatches(rule: RoutingRule, auth: AuthContext, model: string): boolean {
  const m = rule.match ?? {};
  if (m.model && !model.toLowerCase().includes(m.model.toLowerCase())) return false;
  if (m.cost_center && (auth.costCenter || '').toLowerCase() !== m.cost_center.toLowerCase()) return false;
  if (m.team_id && auth.attribution?.teamId?.toString() !== m.team_id) return false;
  if (m.project_id && auth.attribution?.projectId?.toString() !== m.project_id) return false;
  return true;
}

// ── ranking ──────────────────────────────────────────────────────────────────

export interface RankDeps {
  estimateCost: (t: RouteTarget) => number | null;   // null = unknown price
  latencyMs: (t: RouteTarget) => number | null;      // null = no observations
}

/** Stable sort with unknown values last. */
function sortBy(targets: RouteTarget[], metric: (t: RouteTarget) => number | null): RouteTarget[] {
  return targets
    .map((t, i) => ({ t, i, v: metric(t) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return a.v - b.v || a.i - b.i;
    })
    .map(x => x.t);
}

export function rankTargets(
  strategy: Strategy,
  targets: RouteTarget[],
  allowedProviders: string[],
  deps: RankDeps
): RouteTarget[] {
  switch (strategy) {
    case 'cheapest': return sortBy(targets, deps.estimateCost);
    case 'fastest':  return sortBy(targets, deps.latencyMs);
    case 'policy':
      return allowedProviders.length ? targets.filter(t => allowedProviders.includes(t.provider)) : targets;
    default:         return targets;
  }
}

// ── observed latency (rolling 24h average per provider+model) ───────────────

let latencyCache: { at: number; map: Map<string, number> } | null = null;

async function latencyMap(): Promise<Map<string, number>> {
  if (latencyCache && Date.now() - latencyCache.at < 60_000) return latencyCache.map;
  const map = new Map<string, number>();
  try {
    const { rows } = await getPool().query<{ provider: string; model: string; avg_ms: string }>(
      `SELECT provider, model, AVG(duration_ms)::text AS avg_ms
         FROM transactions
        WHERE created_at > now() - interval '24 hours' AND status = 'success' AND duration_ms IS NOT NULL
        GROUP BY provider, model`
    );
    for (const r of rows) map.set(`${r.provider}:${r.model}`, parseFloat(r.avg_ms));
  } catch { /* no data: all unknown */ }
  latencyCache = { at: Date.now(), map };
  return map;
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Returns the routing decision for this request, or null when no rule applies.
 * Fail-open: any error means "no rule", never a failed request.
 */
export async function resolveRoute(
  auth: AuthContext,
  request: OpenAIChatCompletionRequest,
  requestId?: string
): Promise<RouteDecision | null> {
  if (!process.env.DATABASE_URL || auth.organizationId === BigInt(0)) return null;

  try {
    const rules = await loadRules(auth.organizationId);
    const rule = rules.find(r => Array.isArray(r.targets) && r.targets.length > 0 && ruleMatches(r, auth, request.model));
    if (!rule) return null;

    const inTokens = estimateRequestTokens(request.messages);
    const outTokens = request.max_tokens ?? 500;
    const latencies = rule.strategy === 'fastest' ? await latencyMap() : new Map<string, number>();

    const candidates = rankTargets(rule.strategy, rule.targets, auth.allowedProviders ?? [], {
      estimateCost: t => {
        const c = calculateCost(t.provider as any, t.model, inTokens, outTokens);
        return c > 0 ? c : null; // 0 means price unknown
      },
      latencyMs: t => latencies.get(`${t.provider}:${t.model}`) ?? null,
    });
    if (candidates.length === 0) return null;

    logDecision({
      organizationId: auth.organizationId,
      kind: 'routing',
      subjectId: rule.id,
      requestId,
      decision: 'route',
      reason: `${rule.strategy}: ${candidates.map(c => `${c.provider}:${c.model}`).join(' > ')}`,
      metadata: { rule: rule.name, requestedModel: request.model },
    });
    return { rule, strategy: rule.strategy, candidates };
  } catch (err: any) {
    console.warn('[Routing] rule evaluation failed, using default routing:', err.message);
    return null;
  }
}
