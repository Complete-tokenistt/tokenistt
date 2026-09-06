/**
 * services/anomalyDetector.ts — Statistical anomaly detection for AI FinOps.
 *
 * Implements Phase 16 & Milestone 6.4:
 * 1. Spend Anomaly: Current 24h spend > 3× rolling baseline
 * 2. Token Anomaly: Average tokens per request > 5× rolling baseline
 * 3. Model Shift Anomaly: Expensive tier model usage ratio > 2× baseline
 *
 * Deterministic and statistical (no black-box ML dependencies required for core operations).
 */

import { getPool } from '../db/pool.js';

export interface AnomalyResult {
  detected: boolean;
  anomalyType: 'spend_spike' | 'token_spike' | 'model_shift';
  severity: 'info' | 'warn' | 'critical';
  currentValue: number;
  baselineValue: number;
  ratio: number;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Calculates whether spend in the last 24 hours is anomalous (> 3x baseline).
 */
export function evaluateSpendAnomaly(
  spend24h: number,
  avgDailyBaseline: number,
  thresholdMultiplier = 3.0
): AnomalyResult {
  if (avgDailyBaseline <= 0) {
    // Insufficient baseline to assert an anomaly
    return {
      detected: false,
      anomalyType: 'spend_spike',
      severity: 'info',
      currentValue: spend24h,
      baselineValue: avgDailyBaseline,
      ratio: 1.0,
      message: 'Insufficient baseline data for spend anomaly detection.',
    };
  }

  const ratio = spend24h / avgDailyBaseline;
  const detected = ratio >= thresholdMultiplier;
  const severity = ratio >= 5.0 ? 'critical' : ratio >= 3.0 ? 'warn' : 'info';

  return {
    detected,
    anomalyType: 'spend_spike',
    severity,
    currentValue: Math.round(spend24h * 100) / 100,
    baselineValue: Math.round(avgDailyBaseline * 100) / 100,
    ratio: Math.round(ratio * 100) / 100,
    message: detected
      ? `Spend in last 24h ($${spend24h.toFixed(2)}) is ${ratio.toFixed(1)}× higher than normal baseline ($${avgDailyBaseline.toFixed(2)}).`
      : 'Spend within normal baseline tolerance.',
  };
}

/**
 * Calculates whether average tokens per request is anomalous (> 5x baseline).
 */
export function evaluateTokenAnomaly(
  avgTokensToday: number,
  avgTokensBaseline: number,
  thresholdMultiplier = 5.0
): AnomalyResult {
  if (avgTokensBaseline <= 0) {
    return {
      detected: false,
      anomalyType: 'token_spike',
      severity: 'info',
      currentValue: avgTokensToday,
      baselineValue: avgTokensBaseline,
      ratio: 1.0,
      message: 'Insufficient baseline data for token anomaly detection.',
    };
  }

  const ratio = avgTokensToday / avgTokensBaseline;
  const detected = ratio >= thresholdMultiplier;
  const severity = ratio >= 10.0 ? 'critical' : ratio >= 5.0 ? 'warn' : 'info';

  return {
    detected,
    anomalyType: 'token_spike',
    severity,
    currentValue: Math.round(avgTokensToday),
    baselineValue: Math.round(avgTokensBaseline),
    ratio: Math.round(ratio * 100) / 100,
    message: detected
      ? `Average tokens per request (${Math.round(avgTokensToday)}) is ${ratio.toFixed(1)}× higher than normal context baseline (${Math.round(avgTokensBaseline)}).`
      : 'Token consumption per request is within normal baseline tolerance.',
  };
}

/**
 * Calculates whether expensive model usage share shifted abnormally (> 2x baseline).
 */
export function evaluateModelShiftAnomaly(
  expensiveShareCurrent: number, // 0.0 to 1.0
  expensiveShareBaseline: number, // 0.0 to 1.0
  thresholdMultiplier = 2.0
): AnomalyResult {
  if (expensiveShareBaseline <= 0) {
    return {
      detected: false,
      anomalyType: 'model_shift',
      severity: 'info',
      currentValue: expensiveShareCurrent,
      baselineValue: expensiveShareBaseline,
      ratio: 1.0,
      message: 'Insufficient baseline data for model shift detection.',
    };
  }

  const ratio = expensiveShareCurrent / expensiveShareBaseline;
  const detected = ratio >= thresholdMultiplier && expensiveShareCurrent > 0.3; // Must also represent at least 30% of total
  const severity = ratio >= 3.0 ? 'critical' : ratio >= 2.0 ? 'warn' : 'info';

  return {
    detected,
    anomalyType: 'model_shift',
    severity,
    currentValue: Math.round(expensiveShareCurrent * 1000) / 10,
    baselineValue: Math.round(expensiveShareBaseline * 1000) / 10,
    ratio: Math.round(ratio * 100) / 100,
    message: detected
      ? `Expensive tier model share (${(expensiveShareCurrent * 100).toFixed(1)}%) jumped ${ratio.toFixed(1)}× over baseline (${(expensiveShareBaseline * 100).toFixed(1)}%).`
      : 'Model distribution is within normal variation parameters.',
  };
}

/**
 * Scans Postgres transactions for an organization to evaluate all anomalies.
 */
export async function scanOrgAnomalies(orgId: string | number): Promise<AnomalyResult[]> {
  if (!process.env.DATABASE_URL) {
    return [];
  }

  try {
    const pool = getPool();

    // 1. Spend query: 24h spend vs 7-day average
    const spendRes = await pool.query<{ spend_24h: string; avg_daily: string }>(`
      WITH daily_7d AS (
        SELECT COALESCE(SUM(cost_usd) / 7.0, 0) AS avg_daily
        FROM transactions
        WHERE organization_id = $1
          AND status = 'success'
          AND created_at >= now() - interval '7 days'
      ),
      last_24h AS (
        SELECT COALESCE(SUM(cost_usd), 0) AS spend_24h
        FROM transactions
        WHERE organization_id = $1
          AND status = 'success'
          AND created_at >= now() - interval '24 hours'
      )
      SELECT spend_24h::text, avg_daily::text FROM last_24h, daily_7d
    `, [orgId]);

    const spend24h = parseFloat(spendRes.rows[0]?.spend_24h ?? '0');
    const avgDaily = parseFloat(spendRes.rows[0]?.avg_daily ?? '0');
    const spendAnomaly = evaluateSpendAnomaly(spend24h, avgDaily);

    // 2. Token query: 24h avg tokens vs 7-day avg tokens
    const tokenRes = await pool.query<{ tokens_24h: string; tokens_7d: string }>(`
      WITH tokens_7d AS (
        SELECT COALESCE(AVG(total_tokens), 0) AS tokens_7d
        FROM transactions
        WHERE organization_id = $1
          AND status = 'success'
          AND created_at >= now() - interval '7 days'
      ),
      tokens_24h AS (
        SELECT COALESCE(AVG(total_tokens), 0) AS tokens_24h
        FROM transactions
        WHERE organization_id = $1
          AND status = 'success'
          AND created_at >= now() - interval '24 hours'
      )
      SELECT tokens_24h::text, tokens_7d::text FROM tokens_24h, tokens_7d
    `, [orgId]);

    const tokens24h = parseFloat(tokenRes.rows[0]?.tokens_24h ?? '0');
    const tokens7d = parseFloat(tokenRes.rows[0]?.tokens_7d ?? '0');
    const tokenAnomaly = evaluateTokenAnomaly(tokens24h, tokens7d);

    const anomalies: AnomalyResult[] = [];
    if (spendAnomaly.detected) anomalies.push(spendAnomaly);
    if (tokenAnomaly.detected) anomalies.push(tokenAnomaly);

    return anomalies;
  } catch (err: any) {
    console.error('[AnomalyDetector] Error scanning org anomalies:', err.message);
    return [];
  }
}

