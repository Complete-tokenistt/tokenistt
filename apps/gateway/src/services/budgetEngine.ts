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
import { logDecision } from './auditLogger.js';
import { notifyAll } from './notify.js';

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


type ScopeType = 'organization' | 'team' | 'project' | 'virtual_key';

const SPEND_COLUMN: Record<ScopeType, string> = {
  organization: 'organization_id',
  team: 'team_id',
  project: 'project_id',
  virtual_key: 'virtual_key_id',
};
const PERIOD_UNIT: Record<string, string> = { daily: 'day', weekly: 'week', monthly: 'month' };

/** Ordering used to pick the most restrictive result across the hierarchy. */
function severity(r: BudgetCheckResult): number {
  if (r.action === 'block') return 4;
  if (r.level === 'exceeded') return 3;
  if (r.action === 'throttle') return 2;
  if (r.level === 'critical') return 1.5;
  return r.level === 'warn' ? 1 : 0;
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

  // 2. Hierarchical database budgets (Org / Team / Project / Virtual Key).
  //    Each budget is evaluated only against spend inside its own scope, and only
  //    when the request belongs to that scope.
  let worst: BudgetCheckResult | null = null;
  if (process.env.DATABASE_URL && auth.organizationId && auth.organizationId !== BigInt(0)) {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{
        id: string;
        scope_type: ScopeType;
        scope_id: string;
        cap_usd: string;
        period: string;
        warn_threshold_pct: string;
        critical_threshold_pct: string;
        enforcement_mode: string;
      }>(`
        SELECT id::text, scope_type, scope_id::text, cap_usd::text, period,
               warn_threshold_pct::text, critical_threshold_pct::text, enforcement_mode
        FROM budgets
        WHERE organization_id = $1 AND is_active = true
      `, [auth.organizationId.toString()]);

      const scopeIds: Record<ScopeType, string | null> = {
        organization: auth.organizationId.toString(),
        team: auth.attribution?.teamId?.toString() ?? null,
        project: auth.attribution?.projectId?.toString() ?? null,
        virtual_key: auth.virtualKeyId.toString(),
      };

      for (const b of rows) {
        if (scopeIds[b.scope_type] !== b.scope_id) continue; // request is not in this budget's scope

        const cap = parseFloat(b.cap_usd);
        const warnPct = parseFloat(b.warn_threshold_pct || '80');
        const critPct = parseFloat(b.critical_threshold_pct || '90');
        const mode = (b.enforcement_mode as any) || 'hard_cap';
        const spendCol = SPEND_COLUMN[b.scope_type];

        const spendRes = await pool.query<{ total: string }>(`
          SELECT COALESCE(SUM(cost_usd), 0)::text AS total
          FROM transactions
          WHERE organization_id = $1
            AND ${spendCol} = $2
            AND ($3::text = 'none' OR created_at >= date_trunc($4, now()))
        `, [auth.organizationId.toString(), b.scope_id, b.period, PERIOD_UNIT[b.period] ?? 'month']);

        const used = parseFloat(spendRes.rows[0]?.total ?? '0') + estimatedCostUsd;
        const res: BudgetCheckResult = {
          ...evaluateBudgetThreshold(used, cap, mode, warnPct, critPct),
          scopeType: b.scope_type,
          budgetId: b.id,
        };
        if (!worst || severity(res) > severity(worst)) worst = res;
      }
    } catch (err: any) {
      console.warn('[BudgetEngine] Error querying hierarchical budgets, failing open:', err.message);
    }
  }
  if (worst && worst.level !== 'ok') return worst;

  return {
    allowed: true,
    action: 'notify',
    level: 'ok',
    usedUsd: auth.budgetUsedUsd,
    capUsd: auth.budgetCapUsd ?? 0,
    percentUsed: auth.budgetCapUsd && auth.budgetCapUsd > 0 ? (auth.budgetUsedUsd / auth.budgetCapUsd) * 100 : 0,
  };
}


// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

export interface BudgetEnforcement {
  allowed: boolean;
  result?: BudgetCheckResult;
  /** Delay to apply before forwarding when a budget is in auto_throttle mode. */
  throttleMs: number;
}

const THROTTLE_MS = parseInt(process.env.BUDGET_THROTTLE_MS || '500', 10);

/**
 * Runs the hierarchical budget check for a request, records the decision in the
 * audit trail, persists a deduplicated alert row and notifies on critical/exceeded.
 * Fail-open: any internal error allows the request.
 */
export async function enforceBudgets(auth: AuthContext, requestId?: string): Promise<BudgetEnforcement> {
  let result: BudgetCheckResult;
  try {
    result = await checkAllBudgets(auth);
  } catch (err: any) {
    console.warn('[BudgetEngine] enforcement error, failing open:', err.message);
    return { allowed: true, throttleMs: 0 };
  }
  if (result.level === 'ok') return { allowed: true, throttleMs: 0 };

  logDecision({
    organizationId: auth.organizationId,
    kind: 'budget',
    subjectId: result.budgetId,
    requestId,
    decision: result.action === 'block' ? 'block' : result.action === 'throttle' ? 'throttle' : 'warn',
    reason: result.reason,
    metadata: { level: result.level, scope: result.scopeType, used: result.usedUsd, cap: result.capUsd },
  });

  if (result.budgetId && /^\d+$/.test(result.budgetId)) {
    persistAlert(auth, result).catch(() => {});
  }

  return {
    allowed: result.allowed,
    result,
    throttleMs: result.action === 'throttle' ? THROTTLE_MS : 0,
  };
}

/** One alert per budget+severity per hour. */
async function persistAlert(auth: AuthContext, r: BudgetCheckResult): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const severityName = r.level === 'exceeded' ? 'exceeded' : r.level === 'critical' ? 'critical' : 'warn';
  const pool = getPool();
  const recent = await pool.query(
    `SELECT 1 FROM budget_alerts
      WHERE budget_id = $1 AND severity = $2 AND created_at > now() - interval '1 hour' LIMIT 1`,
    [r.budgetId, severityName]
  );
  if (recent.rowCount) return;

  const title = `Budget ${severityName}: ${r.scopeType} budget at ${r.percentUsed.toFixed(1)}%`;
  const channels = severityName === 'warn' ? [] : await notifyAll({
    title,
    text: r.reason ?? title,
    fields: { Scope: r.scopeType ?? '', 'Used (USD)': r.usedUsd.toFixed(2), 'Cap (USD)': r.capUsd.toFixed(2) },
    severity: severityName === 'exceeded' ? 'critical' : 'warn',
  });

  await pool.query(
    `INSERT INTO budget_alerts (organization_id, budget_id, virtual_key_id, severity, title, message, channels, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [auth.organizationId.toString(), r.budgetId, auth.virtualKeyId.toString(), severityName, title,
     r.reason ?? title, JSON.stringify(channels), JSON.stringify({ scope: r.scopeType, used: r.usedUsd, cap: r.capUsd })]
  );
}
