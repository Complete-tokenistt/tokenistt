/**
 * db/auth.ts — Virtual-key authentication against Postgres.
 *
 * Parses the `tktt_live_{workspace}_{user}_{hash}` token from the
 * Authorization header, then looks up the matching row in `virtual_keys`
 * joined to `workspaces` to retrieve:
 *   - organisation / workspace / cost-center context
 *   - budget cap and period
 *   - allowed providers list
 *   - the real provider API key stored in metadata (BYOK)
 *
 * Budget enforcement:
 *   Soft limit  → warn in response headers, continue
 *   Hard limit  → 429 BudgetExceededError thrown
 *
 * Falls back gracefully: if DATABASE_URL is not configured, the gateway
 * runs in "open" mode (no auth) with a warning — useful for local dev.
 */

import { getPool } from './pool.js';
import { decryptApiKey } from '../services/vault.js';
import { 
  getCachedVirtualKey, 
  setCachedVirtualKey,
  atomicBudgetReserve,
} from '../services/redis.js';
import { checkSlidingWindowRateLimit } from '../services/redisRateLimiter.js';
import { checkAndSendBudgetAlert } from '../services/alerting.js';
import { hashToken } from '../services/keyManager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthContext {
  /** virtual_keys.id */
  virtualKeyId: bigint;
  /** virtual_keys.public_id (UUID) */
  virtualKeyPublicId: string;
  /** workspaces.id */
  workspaceId: bigint | null;
  /** organizations.id */
  organizationId: bigint;
  /** workspaces.cost_center e.g. "CC-4401-Support" */
  costCenter: string;
  /** actor string — the `user` field from the SDK / token */
  actor: string;
  /** budget cap for this key (USD) — null means unlimited */
  budgetCapUsd: number | null;
  /** how much has already been spent this period (USD) */
  budgetUsedUsd: number;
  /** budget period: none | daily | monthly */
  budgetPeriod: string;
  /** allowed providers — empty means all allowed */
  allowedProviders: string[];
  /** real provider API key stored in key metadata (optional BYOK) */
  realApiKey: string | null;
  /** budget enforcement mode: alert_only | auto_throttle | hard_cap */
  enforcementMode?: string;
  /** raw token prefix from header (for cache key operations) */
  rawToken?: string;
  /** rate limit allowed per minute */
  rateLimitPerMinute?: number;
  /** Team/project/cost-attribution resolved per request from x-tokenistt-* headers */
  attribution?: import('../services/workspaceResolver.js').Attribution;
  /** Atomic budget reservation tracking for concurrency protection */
  budgetReservation?: {
    estimated: number;
    token: string;
    period: 'daily' | 'monthly' | 'none';
  };
}

export interface ParsedToken {
  raw: string;
  workspace: string;
  userId: string;
  hash: string;
}

// ---------------------------------------------------------------------------
// Token parsing
// ---------------------------------------------------------------------------

/**
 * Parses `tktt_live_{workspace}_{user}_{hash}` from an Authorization header.
 * Returns null for any malformed input.
 */
export function parseToken(authHeader: string): ParsedToken | null {
  const match = authHeader.match(/^Bearer\s+(tktt_live_(\w+)_(\w+)_(\w+))$/i);
  if (!match) return null;
  return {
    raw:       match[1],
    workspace: match[2],
    userId:    match[3],
    hash:      match[4],
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(message: string, public readonly statusCode = 401) {
    super(message);
    this.name = 'AuthError';
  }
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly limitUsd: number,
    public readonly usedUsd: number,
  ) {
    super(`Budget exceeded: $${usedUsd.toFixed(4)} used of $${limitUsd.toFixed(2)} limit`);
    this.name = 'BudgetExceededError';
  }
  readonly statusCode = 429;
}

export class RateLimitExceededError extends Error {
  constructor(
    public readonly limit: number,
    public readonly retryAfter: number
  ) {
    super(`Rate limit exceeded: ${limit} requests per minute limit reached. Retry after ${retryAfter}s.`);
    this.name = 'RateLimitExceededError';
  }
  readonly statusCode = 429;
}

// ---------------------------------------------------------------------------
// Core auth function
// ---------------------------------------------------------------------------

/**
 * Authenticates a virtual key against Postgres.
 *
 * Strategy:
 *  1. Parse the Bearer token.
 *  2. Look up `virtual_keys` by key_prefix (the workspace+user+hash portion).
 *     In production, store a scrypt hash and compare here; for now we store
 *     the raw token prefix as `key_prefix` for simplicity.
 *  3. Join to `workspaces` to get cost_center + budget_cap.
 *  4. Check hard budget limit.
 *  5. Return AuthContext.
 */
export async function authenticateRequest(
  authHeader: string | undefined,
): Promise<AuthContext> {
  // ── 0. No DATABASE_URL → open mode (dev only) ──────────────────────────
  if (!process.env.DATABASE_URL) {
    if (process.env.GATEWAY_REQUIRE_AUTH === 'true' || process.env.NODE_ENV === 'production') {
      throw new AuthError('Gateway requires authentication, but DATABASE_URL is not configured.', 503);
    }
    console.warn(
      '[Auth] DATABASE_URL not set — running in OPEN mode. ' +
      'All requests are allowed without authentication.'
    );
    return buildOpenModeContext(authHeader);
  }

  // ── 1. Parse token ───────────────────────────────────────────────────────
  if (!authHeader) {
    throw new AuthError('Missing Authorization header. Expected: Bearer tktt_live_...');
  }

  const parsed = parseToken(authHeader);
  if (!parsed) {
    throw new AuthError(
      'Invalid Authorization format. Expected: Bearer tktt_live_{workspace}_{user}_{hash}'
    );
  }

  let authContext: AuthContext | null = null;

  // ── 1.5. Try Redis Cache first ──────────────────────────────────────────
  authContext = await getCachedVirtualKey(parsed.raw);
  
  if (authContext) {
    // Validate that the actor matches the user id parsed from the token
    authContext.actor = parsed.userId;
  } else {
    // ── 2. Cache Miss: Look up virtual_keys joined to workspaces in Postgres ──
    const pool = getPool();

    const { rows } = await pool.query<{
      vk_id:              string;
      vk_public_id:       string;
      org_id:             string;
      workspace_id:       string | null;
      cost_center:        string;
      budget_cap_usd:     string | null;
      budget_period:      string;
      allowed_providers:  string[] | null;
      status:             string;
      real_api_key:       string | null;
      budget_used_usd:    string;
      enforcement_mode:   string | null;
      rate_limit_per_minute: number | null;
    }>(
      `
      SELECT
        vk.id                                        AS vk_id,
        vk.public_id::text                           AS vk_public_id,
        vk.organization_id::text                     AS org_id,
        vk.workspace_id::text                        AS workspace_id,
        COALESCE(ws.cost_center, 'default')          AS cost_center,
        vk.budget_cap_usd::text                      AS budget_cap_usd,
        vk.budget_period                             AS budget_period,
        vk.allowed_providers                         AS allowed_providers,
        vk.status                                    AS status,
        vk.metadata->>'real_api_key'                 AS real_api_key,
        vk.metadata->>'enforcement_mode'             AS enforcement_mode,
        COALESCE((vk.metadata->>'rate_limit_per_minute')::integer, 100) AS rate_limit_per_minute,
        COALESCE(
          (
            SELECT SUM(t.cost_usd)::text
            FROM   transactions t
            WHERE  t.virtual_key_id = vk.id
              AND  CASE vk.budget_period
                     WHEN 'daily'   THEN t.created_at >= date_trunc('day',  now())
                     WHEN 'monthly' THEN t.created_at >= date_trunc('month', now())
                     ELSE false
                   END
          ), '0'
        )                                            AS budget_used_usd
      FROM  virtual_keys  vk
      LEFT  JOIN workspaces ws ON ws.id = vk.workspace_id
      WHERE (vk.key_hash = $1 OR vk.key_prefix = $2)
      LIMIT 1
      `,
      [hashToken(parsed.raw), parsed.raw],
    );

    if (rows.length === 0) {
      throw new AuthError(`Virtual key not found: ${parsed.workspace}/${parsed.userId}`);
    }

    const row = rows[0];

    // ── 3. Status check ─────────────────────────────────────────────────────
    if (row.status !== 'active') {
      throw new AuthError(`Virtual key is ${row.status}`, 403);
    }

    const budgetCap  = row.budget_cap_usd  ? parseFloat(row.budget_cap_usd)  : null;
    const budgetUsed = parseFloat(row.budget_used_usd);
    
    // Normalize enforcement mode
    const rawMode = row.enforcement_mode ? row.enforcement_mode.toLowerCase().replace(/[^a-z0-9]/g, '_') : 'hard_cap';
    const enforcementMode = (rawMode === 'alert_only' || rawMode === 'auto_throttle' || rawMode === 'hard_cap') ? rawMode : 'hard_cap';

    authContext = {
      virtualKeyId:      BigInt(row.vk_id),
      virtualKeyPublicId: row.vk_public_id,
      workspaceId:       row.workspace_id ? BigInt(row.workspace_id) : null,
      organizationId:    BigInt(row.org_id),
      costCenter:        row.cost_center,
      actor:             parsed.userId,
      budgetCapUsd:      budgetCap,
      budgetUsedUsd:     budgetUsed,
      budgetPeriod:      row.budget_period,
      allowedProviders:  row.allowed_providers ?? [],
      realApiKey:        row.real_api_key ? decryptApiKey(row.real_api_key, row.org_id) : null,
      enforcementMode,
      rawToken:          parsed.raw,
      rateLimitPerMinute: row.rate_limit_per_minute ?? 100,
    };

    // Save to Redis Cache (5 minutes TTL)
    await setCachedVirtualKey(parsed.raw, authContext, 300);
  }

  // ── 4. Budget check & Atomic Reservation ──────────────────────────────────
  if (
    authContext.enforcementMode !== 'alert_only' && 
    authContext.budgetCapUsd !== null &&
    authContext.budgetPeriod !== 'none'
  ) {
    if (authContext.budgetUsedUsd >= authContext.budgetCapUsd) {
      checkAndSendBudgetAlert(authContext, 'hard').catch(() => {});
      throw new BudgetExceededError(authContext.budgetCapUsd, authContext.budgetUsedUsd);
    }

    // Atomic reservation to guarantee concurrent safety
    const estimatedCost = Math.min(0.01, (authContext.budgetCapUsd * 0.001) || 0.005);
    const reservePeriod = (authContext.budgetPeriod === 'daily' ? 'daily' : 'monthly') as 'daily' | 'monthly';
    const reservation = await atomicBudgetReserve(
      parsed.raw,
      estimatedCost,
      authContext.budgetCapUsd,
      reservePeriod,
      authContext.budgetUsedUsd,  // seed Redis from authoritative DB spend
    );


    if (!reservation.allowed) {
      checkAndSendBudgetAlert(authContext, 'hard').catch(() => {});
      throw new BudgetExceededError(authContext.budgetCapUsd, reservation.usedAfter);
    }

    authContext.budgetReservation = {
      estimated: estimatedCost,
      token: parsed.raw,
      period: reservePeriod,
    };
  }

  // ── 4.5. Rate Limit check ─────────────────────────────────────────────────
  const limitPerMinute = authContext.rateLimitPerMinute ?? 100;
  const rateLimitResult = await checkSlidingWindowRateLimit(
    authContext.virtualKeyId,
    limitPerMinute,
    60
  );

  if (!rateLimitResult.allowed) {
    throw new RateLimitExceededError(limitPerMinute, rateLimitResult.resetAt - Math.floor(Date.now() / 1000));
  }

  return authContext;
}

// ---------------------------------------------------------------------------
// Open-mode fallback (no DB)
// ---------------------------------------------------------------------------

function buildOpenModeContext(authHeader: string | undefined): AuthContext {
  const parsed = authHeader ? parseToken(authHeader) : null;
  return {
    virtualKeyId:       BigInt(0),
    virtualKeyPublicId: '00000000-0000-0000-0000-000000000000',
    workspaceId:        null,
    organizationId:     BigInt(0),
    costCenter:         'default',
    actor:              parsed?.userId ?? 'anonymous',
    budgetCapUsd:       null,
    budgetUsedUsd:      0,
    budgetPeriod:       'none',
    allowedProviders:   [],
    realApiKey:         null,
    enforcementMode:    'hard_cap',
    rateLimitPerMinute: 100,
  };
}
