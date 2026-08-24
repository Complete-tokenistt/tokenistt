import axios from 'axios';
import { AuthContext } from '../db/auth.js';
import { getRedisClient } from './redis.js';

export type AlertType = 'soft' | 'hard';

export interface AlertPayload {
  type: AlertType;
  actor: string;
  costCenter: string;
  virtualKeyPublicId: string;
  usedUsd: number;
  capUsd: number;
  percentage: number;
  timestamp: string;
}

/**
 * Send budget alert to configured Slack/webhook endpoint with deduplication via Redis.
 */
export async function checkAndSendBudgetAlert(
  auth: AuthContext,
  type: AlertType
): Promise<boolean> {
  if (auth.budgetCapUsd === null || auth.budgetCapUsd <= 0) {
    return false;
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL || process.env.BUDGET_ALERT_WEBHOOK_URL;
  const percentage = (auth.budgetUsedUsd / auth.budgetCapUsd) * 100;
  const todayStr = new Date().toISOString().slice(0, 10);
  const dedupKey = `gateway:alerts:${auth.virtualKeyPublicId}:${type}:${todayStr}`;

  // 1. Redis Deduplication Check
  const redis = getRedisClient();
  if (redis) {
    try {
      const alreadySent = await redis.get(dedupKey);
      if (alreadySent) {
        return false; // Already alerted today for this threshold
      }
    } catch (err: any) {
      console.error('[Alerting] Redis dedup check error:', err.message);
    }
  }

  const payload: AlertPayload = {
    type,
    actor: auth.actor,
    costCenter: auth.costCenter,
    virtualKeyPublicId: auth.virtualKeyPublicId,
    usedUsd: auth.budgetUsedUsd,
    capUsd: auth.budgetCapUsd,
    percentage: parseFloat(percentage.toFixed(1)),
    timestamp: new Date().toISOString(),
  };

  const emoji = type === 'hard' ? '🚨' : '⚠️';
  const title = type === 'hard' ? 'CRITICAL: Budget Limit Exceeded' : 'WARNING: Approaching Budget Limit';
  const color = type === 'hard' ? '#E53E3E' : '#DD6B20';

  console.warn(
    `[Budget Alert ${emoji}] Key ${auth.virtualKeyPublicId} (${auth.actor} @ ${auth.costCenter}) ` +
    `spent $${auth.budgetUsedUsd.toFixed(4)} of $${auth.budgetCapUsd.toFixed(2)} (${percentage.toFixed(1)}%)`
  );

  // 2. Dispatch to Slack/Webhook if configured
  if (webhookUrl) {
    try {
      await axios.post(webhookUrl, {
        text: `${emoji} *${title}* for \`${auth.costCenter}\``,
        attachments: [
          {
            color,
            fields: [
              { title: 'User / Actor', value: auth.actor, short: true },
              { title: 'Cost Center', value: auth.costCenter, short: true },
              { title: 'Spent (USD)', value: `$${auth.budgetUsedUsd.toFixed(4)}`, short: true },
              { title: 'Budget Cap (USD)', value: `$${auth.budgetCapUsd.toFixed(2)}`, short: true },
              { title: 'Utilization', value: `${percentage.toFixed(1)}%`, short: true },
              { title: 'Enforcement Mode', value: auth.enforcementMode, short: true },
            ],
            footer: 'Tokenistt FinOps Gateway',
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      });
    } catch (err: any) {
      console.error('[Alerting] Failed to deliver webhook alert:', err.message);
    }
  }

  // 3. Record alert sent in Redis with 24-hour TTL
  if (redis) {
    try {
      await redis.setex(dedupKey, 86400, 'sent');
    } catch (err: any) {
      console.error('[Alerting] Failed to record dedup key:', err.message);
    }
  }

  return true;
}
