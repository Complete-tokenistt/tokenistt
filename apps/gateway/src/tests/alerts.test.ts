import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkAndSendBudgetAlert } from '../services/alerting.js';
import type { AuthContext } from '../db/auth.js';

describe('Phase 3 — FinOps Intelligence & Budget Alerting', () => {
  const dummyAuth: AuthContext = {
    virtualKeyId: BigInt(1),
    virtualKeyPublicId: `vk-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: BigInt(1),
    organizationId: BigInt(1),
    costCenter: 'CC-Engineering',
    actor: 'developer-1',
    budgetCapUsd: 100.0,
    budgetUsedUsd: 85.0,
    budgetPeriod: 'monthly',
    allowedProviders: [],
    realApiKey: null,
    enforcementMode: 'hard_cap',
    rawToken: 'tktt_live_test_123',
    rateLimitPerMinute: 100,
  };

  test('returns false when budgetCapUsd is null or zero', async () => {
    const authNoCap: AuthContext = { ...dummyAuth, budgetCapUsd: null };
    const sent = await checkAndSendBudgetAlert(authNoCap, 'soft');
    assert.equal(sent, false);
  });

  test('generates soft warning when approaching cap without throwing', async () => {
    const sent = await checkAndSendBudgetAlert(dummyAuth, 'soft');
    assert.equal(sent, true);
  });

  test('generates hard critical alert when exceeded without throwing', async () => {
    const authExceeded: AuthContext = { ...dummyAuth, budgetUsedUsd: 105.0 };
    const sent = await checkAndSendBudgetAlert(authExceeded, 'hard');
    assert.equal(sent, true);
  });
});

