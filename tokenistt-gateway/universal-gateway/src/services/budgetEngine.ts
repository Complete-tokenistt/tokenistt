/**
 * services/budgetEngine.ts — Multi-level hierarchical budget evaluation.
 *
 * Implements M4.1 & M8.2:
 * - Evaluates multi-level budgets: Organization → Team → Project → Virtual Key
 * - Thresholds: 80% (warn), 90% (critical / throttle), 100% (exceeded / hard block)
 * - Enforcement modes: alert_only | auto_throttle | hard_cap
 */

import { AuthContext } from '../db/auth.js';
import { getPool } from '../db/pool.js';

export interface BudgetCheckResult {
  allowed: boolean;
  action: 'notify' | 'throttle' | 'block';
  level: 'ok' | 'warn' | 'critical' | 'exceeded';
  budgetId?: string;
  scopeType?: string;
  usedUsd: number;
  capUsd: number;
  percentUsed: number;
  reason?: string;
}

/**
 * Evaluates budget status against thresholds and enforcement mode.
 */
export function evaluateBudgetThreshold(
  usedUsd: number,
  capUsd: number,
  enforcementMode: 'alert_only' | 'auto_throttle' | 'hard_cap' = 'hard_cap',
  warnPct = 80.0,
  criticalPct = 90.0
): BudgetCheckResult {
  if (capUsd <= 0) {
    return {
      allowed: true,
      action: 'notify',
      level: 'ok',
      usedUsd,
      capUsd,
      percentUsed: 0,
    };
  }

  const percentUsed = (usedUsd / capUsd) * 100;

  if (percentUsed >= 100) {
    const isHard = enforcementMode === 'hard_cap';
    return {
      allowed: !isHard,
      action: isHard ? 'block' : 'notify',
      level: 'exceeded',
      usedUsd,
      capUsd,
      percentUsed,
      reason: `Budget cap of $${capUsd.toFixed(2)} exceeded (used $${usedUsd.toFixed(2)}, ${percentUsed.toFixed(1)}%).`,
    };
  }

  if (percentUsed >= criticalPct) {
    return {
      allowed: true,
      action: enforcementMode === 'auto_throttle' ? 'throttle' : 'notify',
      level: 'critical',
      usedUsd,
      capUsd,
      percentUsed,
      reason: `Approaching critical budget threshold (${percentUsed.toFixed(1)}% of $${capUsd.toFixed(2)}).`,
    };
  }

  if (percentUsed >= warnPct) {
    return {
      allowed: true,
      action: 'notify',
      level: 'warn',
      usedUsd,
      capUsd,
      percentUsed,
      reason: `Approaching budget warning threshold (${percentUsed.toFixed(1)}% of $${capUsd.toFixed(2)}).`,
    };
  }

  return {
    allowed: true,
    action: 'notify',
    level: 'ok',
    usedUsd,
    capUsd,
    percentUsed,
  };
}

/**
 * Checks all hierarchical budgets (Virtual Key, Project, Team, Organization).
 * The most restrictive action in the hierarchy is enforced.
 */
export async function checkAllBudgets(
  auth: AuthContext,
  estimatedCostUsd = 0.001
): Promise<BudgetCheckResult> {
  // 1. Virtual Key budget check (fastest, evaluated from in-memory AuthContext)
  if (auth.budgetCapUsd && auth.budgetCapUsd > 0) {
    const projectedUsed = auth.budgetUsedUsd + estimatedCostUsd;
    const mode = (auth.enforcementMode as any) || 'hard_cap';
    const vkResult = evaluateBudgetThreshold(projectedUsed, auth.budgetCapUsd, mode);
    if (!vkResult.allowed || vkResult.action === 'block') {
      return {
        ...vkResult,
        scopeType: 'virtual_key',
        budgetId: auth.virtualKeyPublicId,
      };
    }
  }

  // 2. Hierarchical database budgets (Org / Team / Project)
  if (process.env.DATABASE_URL && auth.organizationId && auth.organizationId !== BigInt(0)) {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{
        id: string;
        scope_type: string;
        cap_usd: string;
        period: string;
        warn_threshold_pct: string;
        critical_threshold_pct: string;
        enforcement_mode: string;
      }>(`
        SELECT id::text, scope_type, cap_usd::text, period,
               warn_threshold_pct::text, critical_threshold_pct::text,
               enforcement_mode
        FROM budgets
        WHERE organization_id = $1 AND is_active = true
        ORDER BY CASE scope_type
          WHEN 'organization' THEN 1
          WHEN 'team' THEN 2
          WHEN 'project' THEN 3
          ELSE 4
        END ASC
      `, [auth.organizationId]);

      for (const b of rows) {
        const cap = parseFloat(b.cap_usd);
        const warnPct = parseFloat(b.warn_threshold_pct || '80');
        const critPct = parseFloat(b.critical_threshold_pct || '90');
        const mode = (b.enforcement_mode as any) || 'hard_cap';

        const periodInterval = b.period === 'daily' ? 'day' : b.period === 'weekly' ? 'week' : 'month';
        const spendRes = await pool.query<{ total: string }>(`
          SELECT COALESCE(SUM(cost_usd), 0)::text AS total
          FROM transactions
          WHERE organization_id = $1
            AND created_at >= date_trunc($2, now())
        `, [auth.organizationId, periodInterval]);

        const used = parseFloat(spendRes.rows[0]?.total ?? '0') + estimatedCostUsd;
        const res = evaluateBudgetThreshold(used, cap, mode, warnPct, critPct);

        if (!res.allowed || res.action === 'block') {
          return {
            ...res,
            scopeType: b.scope_type,
            budgetId: b.id,
          };
        }
      }
    } catch (err: any) {
      console.warn('[BudgetEngine] Error querying hierarchical budgets, failing open:', err.message);
    }
  }

  return {
    allowed: true,
    action: 'notify',
    level: 'ok',
    usedUsd: auth.budgetUsedUsd,
    capUsd: auth.budgetCapUsd ?? 0,
    percentUsed: auth.budgetCapUsd && auth.budgetCapUsd > 0 ? (auth.budgetUsedUsd / auth.budgetCapUsd) * 100 : 0,
  };
}

