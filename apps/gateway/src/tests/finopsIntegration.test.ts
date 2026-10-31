import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCostWithStatus } from '../services/pricing.js';
import { resolvePricingTierDynamic } from '../services/pricingDb.js';
import { atomicBudgetReserve, adjustBudgetReservation } from '../services/redis.js';
import { setMockPool } from '../db/pool.js';
import { logTransaction, type TransactionPayload } from '../db/transactionLogger.js';
import { upsertHourlyRollup } from '../services/hourlyRollup.js';
import { checkAndSendBudgetAlert } from '../services/alerting.js';
import type { AuthContext } from '../db/auth.js';

describe('Phase 5 — End-to-End FinOps Integration & Lifecycle Pipeline', () => {
  it('verifies dynamic catalog resolution with prompt, completion, and cache discounts', async () => {
    const tier = await resolvePricingTierDynamic('anthropic', 'claude-3-5-sonnet-20241022');
    assert.ok(tier);
    assert.equal(tier.input, 3.00);
    assert.equal(tier.output, 15.00);
    assert.equal(tier.cachedInput, 0.30);

    // 1,000 prompt tokens ($0.003), 500 completion tokens ($0.0075), 2,000 cache read tokens ($0.0006)
    const cost = calculateCostWithStatus(
      'anthropic',
      'claude-3-5-sonnet-20241022',
      1000,
      500,
      2000 // cached tokens
    );

    assert.equal(cost.costStatus, 'ok');
    assert.equal(cost.inputCost, 0.003);
    assert.equal(cost.outputCost, 0.0075);
    assert.equal(cost.cachedInputCost, 0.0006);
    assert.equal(cost.cost, 0.0111);
  });

  it('strictly adheres to Rule #1 & #2: marks unknown models as COST_UNAVAILABLE', () => {
    const cost = calculateCostWithStatus('unknown-provider', 'non-existent-model-xyz', 1000, 500);
    assert.equal(cost.costStatus, 'COST_UNAVAILABLE');
    assert.equal(cost.isKnown, false);
  });

  it('runs atomic budget reservation lifecycle: reserve -> verify allowed -> adjust delta', async () => {
    // 1. Initial reservation for key
    const reserveRes = await atomicBudgetReserve('tktt_live_e2e_key', 0.05, 100.0, 'monthly');
    assert.equal(reserveRes.allowed, true);

    // 2. Adjust with actual cost delta ($0.05 estimated -> $0.045 actual)
    await assert.doesNotReject(async () => {
      await adjustBudgetReservation('tktt_live_e2e_key', 0.05, 0.045, 'monthly');
    });
  });

  it('executes full transaction logging, hourly rollup upsert, and alert pipeline', async () => {
    const origDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/tokenistt_test';

    const executedQueries: Array<{ text: string; values?: any[] }> = [];

    setMockPool({
      query: async (text: string, values?: any[]) => {
        executedQueries.push({ text, values });
        if (text.includes('INSERT INTO transactions')) {
          return { rows: [{ public_id: 'tx_e2e_pub_12345' }] };
        }
        return { rows: [] };
      },
    });

    const mockAuth: AuthContext = {
      actor: 'test-engineer@tokenistt.ai',
      costCenter: 'platform-finops',
      organizationId: BigInt(42),
      workspaceId: BigInt(7),
      virtualKeyId: BigInt(88),
      virtualKeyPublicId: 'tktt_live_e2e_88',
      budgetCapUsd: 10.0,
      budgetUsedUsd: 8.5,
      budgetPeriod: 'monthly',
      allowedProviders: ['anthropic'],
      realApiKey: null,
      enforcementMode: 'soft_cap',
      rateLimitPerMinute: 60,
      budgetReservation: {
        estimated: 0.02,
        token: 'tktt_live_e2e_88',
        period: 'monthly',
      },
    };

    const payload: TransactionPayload = {
      auth: mockAuth,
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      endpoint: '/v1/chat/completions',
      requestId: 'req-finops-e2e-1',
      promptTokens: 1200,
      completionTokens: 400,
      totalTokens: 1600,
      cacheCreationTokens: 0,
      cacheReadTokens: 1000,
      inputCostUsd: 0.0036,
      outputCostUsd: 0.006,
      costUsd: 0.0099,
      durationMs: 412,
      status: 'success',
      projectTag: 'finops-prod',
      metadata: {
        cost_status: 'ok',
        trace_id: 'trc-e2e-001',
      },
    };

    // 1. Log transaction to Postgres
    const txId = await logTransaction(payload);
    assert.equal(txId, 'tx_e2e_pub_12345');

    // 2. Execute hourly spend rollup upsert
    await upsertHourlyRollup({
      organizationId: mockAuth.organizationId,
      teamId: null,
      projectId: null,
      provider: payload.provider,
      model: payload.model,
      costUsd: payload.costUsd,
      totalTokens: payload.totalTokens,
      inputTokens: payload.promptTokens,
      outputTokens: payload.completionTokens,
      isError: false,
    });

    // 3. Trigger budget threshold alert check (8.5 / 10 = 85% > 80% soft warning threshold)
    await checkAndSendBudgetAlert(mockAuth, 'soft');

    // Verify DB calls were dispatched
    const txInsert = executedQueries.find((q) => q.text.includes('INSERT INTO transactions'));
    assert.ok(txInsert, 'transactions table insert must be executed');
    assert.equal(txInsert.values?.[0], BigInt(42)); // organization_id
    assert.equal(txInsert.values?.[4], 'anthropic'); // provider
    assert.equal(txInsert.values?.[5], 'claude-3-5-sonnet-20241022'); // model

    const rollupUpsert = executedQueries.find((q) => q.text.includes('INSERT INTO hourly_spend'));
    assert.ok(rollupUpsert, 'hourly_spend rollup upsert must be executed');
    assert.ok(rollupUpsert.text.includes('ON CONFLICT (organization_id, provider, model, hour_bucket)'));

    const alertInsert = executedQueries.find((q) => q.text.includes('INSERT INTO budget_alerts'));
    assert.ok(alertInsert, 'budget_alerts table insert must be executed');
    assert.equal(alertInsert.values?.[0], BigInt(42)); // organization_id
    assert.equal(alertInsert.values?.[1], BigInt(88)); // virtual_key_id
    assert.equal(alertInsert.values?.[2], 'warn'); // severity

    setMockPool(null);
    if (origDbUrl) {
      process.env.DATABASE_URL = origDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it('guarantees fail-open behavior when database encounters an error', async () => {
    const origDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/tokenistt_test';

    setMockPool({
      query: async () => {
        throw new Error('Postgres connection reset by peer');
      },
    });

    const mockAuth: AuthContext = {
      actor: 'dev@tokenistt.ai',
      costCenter: 'dev',
      organizationId: BigInt(1),
      workspaceId: null,
      virtualKeyId: BigInt(1),
      virtualKeyPublicId: 'tktt_live_failopen',
      budgetCapUsd: null,
      budgetUsedUsd: 0,
      budgetPeriod: 'none',
      allowedProviders: [],
      realApiKey: null,
      enforcementMode: 'hard_cap',
      rateLimitPerMinute: 60,
    };

    // Must return null instead of throwing uncaught exception to caller
    const result = await logTransaction({
      auth: mockAuth,
      provider: 'openai',
      model: 'gpt-4o',
      endpoint: '/v1/chat/completions',
      requestId: 'req-failopen-1',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      inputCostUsd: 0.00025,
      outputCostUsd: 0.0005,
      costUsd: 0.00075,
      durationMs: 150,
      status: 'success',
    });

    assert.equal(result, null);
    setMockPool(null);
    if (origDbUrl) {
      process.env.DATABASE_URL = origDbUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });
});
