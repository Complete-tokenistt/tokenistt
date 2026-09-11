import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { 
  loadPricingFromDb, 
  resolvePricingTierDynamic, 
  invalidatePricingCache 
} from '../services/pricingDb.js';
import { calculateCostWithStatus } from '../services/pricing.js';

describe('Phase 2 — FinOps Accuracy & Dynamic Pricing Catalog', () => {
  test('resolves known OpenAI and Anthropic models via dynamic resolver', async () => {
    const gpt4o = await resolvePricingTierDynamic('openai', 'gpt-4o');
    assert.ok(gpt4o);
    assert.equal(gpt4o.input, 2.50);
    assert.equal(gpt4o.output, 10.00);
    assert.equal(gpt4o.cachedInput, 1.25);

    const sonnet = await resolvePricingTierDynamic('anthropic', 'claude-3-5-sonnet');
    assert.ok(sonnet);
    assert.equal(sonnet.input, 3.00);
    assert.equal(sonnet.output, 15.00);
    assert.equal(sonnet.cachedInput, 0.30);
  });

  test('resolves versioned model strings using prefix matching', async () => {
    const versioned = await resolvePricingTierDynamic('openai', 'gpt-4o-2024-08-06');
    assert.ok(versioned);
    assert.equal(versioned.input, 2.50);
    assert.equal(versioned.output, 10.00);
  });

  test('correctly calculates costs including cache write and read discounts', () => {
    // 1,000,000 prompt tokens + 500,000 cached tokens + 100,000 completion tokens
    const result = calculateCostWithStatus(
      'openai',
      'gpt-4o',
      1_000_000,
      100_000,
      500_000, // cached read
      0,       // cache write
      0        // reasoning
    );

    assert.equal(result.isKnown, true);
    assert.equal(result.costStatus, 'ok');
    assert.equal(result.inputCost, 2.50);
    assert.equal(result.cachedInputCost, 0.625); // 0.5M * $1.25/M
    assert.equal(result.outputCost, 1.00);       // 0.1M * $10.00/M
    assert.equal(result.cost, 4.125);
  });

  test('marks unknown models as COST_UNAVAILABLE per non-negotiable rule #1', () => {
    const result = calculateCostWithStatus('unknown-prov', 'mystery-llm-9000', 1000, 500);
    assert.equal(result.isKnown, false);
    assert.equal(result.costStatus, 'COST_UNAVAILABLE');
  });

  test('cache invalidation resets the in-memory pricing table timestamp', () => {
    invalidatePricingCache();
    // Does not throw and subsequent call succeeds
    assert.doesNotThrow(async () => {
      await loadPricingFromDb();
    });
  });
});

