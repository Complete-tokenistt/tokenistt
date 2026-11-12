import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calculateCost, calculateCostWithStatus, PRICING, getAvailableModels } from '../services/pricing.js';

describe('Pricing Service', () => {
  describe('calculateCost', () => {
    it('should calculate cost for OpenAI GPT-4o ($2.50 in / $10.00 out per 1M)', () => {
      // 1000 input = 0.0025, 500 output = 0.0050 -> total 0.0075
      const cost = calculateCost('openai', 'gpt-4o', 1000, 500);
      assert.strictEqual(cost, 0.0075);
    });

    it('should calculate cost for Anthropic Claude 3.5 Sonnet ($3.00 in / $15.00 out per 1M)', () => {
      // 1000 input = 0.003, 500 output = 0.0075 -> total 0.0105
      const cost = calculateCost('anthropic', 'claude-3-5-sonnet', 1000, 500);
      assert.strictEqual(cost, 0.0105);
    });

    it('should match versioned model names via prefix matching', () => {
      const cost = calculateCost('openai', 'gpt-4o-2024-08-06', 1000, 500);
      assert.strictEqual(cost, 0.0075, 'gpt-4o-2024-08-06 should resolve to gpt-4o pricing');
    });

    it('should calculate cost with prompt cache tokens discount', () => {
      // Claude 3.5 Sonnet: input $3.00/M, output $15.00/M, cachedInput $0.30/M
      // 10,000 normal input = $0.03, 10,000 cached = $0.003, 1,000 output = $0.015 -> $0.048
      const statusRes = calculateCostWithStatus('anthropic', 'claude-3-5-sonnet', 10000, 1000, 10000);
      assert.strictEqual(statusRes.costStatus, 'ok');
      assert.strictEqual(statusRes.cachedInputCost, 0.003);
      assert.strictEqual(statusRes.cost, 0.048);
    });

    it('should flag unknown models with COST_UNAVAILABLE status', () => {
      const result = calculateCostWithStatus('unknown', 'unknown-model-xyz', 1000, 500);
      assert.strictEqual(result.isKnown, false);
      assert.strictEqual(result.costStatus, 'COST_UNAVAILABLE');
    });

    it('should calculate cost for Anthropic Claude 3 Sonnet', () => {
      const cost = calculateCost('anthropic', 'claude-3-sonnet', 1000, 500);
      assert.strictEqual(cost, 0.0105);
    });
    
    it('should calculate cost for Anthropic Claude 3 Opus', () => {
      const cost = calculateCost('anthropic', 'claude-3-opus', 1000, 500);
      assert.strictEqual(cost, 0.0525);
    });
    
    it('should calculate cost for Anthropic Claude 3 Haiku', () => {
      const cost = calculateCost('anthropic', 'claude-3-haiku', 1000, 500);
      assert.strictEqual(cost, 0.000875);
    });
    
    it('prices Bedrock at the list rate with no invented markup', () => {
      // 1M in at $3 + 1M out at $15 = $18 exactly, same as the vendor list price.
      assert.strictEqual(calculateCost('bedrock', 'claude-3-sonnet', 1_000_000, 1_000_000), 18);
      assert.strictEqual(
        calculateCost('bedrock', 'claude-3-sonnet', 1000, 500),
        calculateCost('anthropic', 'claude-3-sonnet', 1000, 500),
      );
    });
    
    it('unknown model must return cost=$0.00 (NEVER invent a fallback price)', () => {
      // B1 FIX: Unknown models must return exactly $0.00, not a guessed default.
      // The old behavior returned 0.0025 using calculateDefaultCost() — that was wrong.
      const cost = calculateCost('unknown', 'unknown-model', 1000, 500);
      assert.strictEqual(cost, 0, 'Unknown model must never produce a non-zero cost');
    });
    
    it('should handle zero tokens', () => {
      const cost = calculateCost('anthropic', 'claude-3-sonnet', 0, 0);
      assert.strictEqual(cost, 0);
    });
    
    it('should handle large token counts', () => {
      const cost = calculateCost('anthropic', 'claude-3-opus', 1000000, 500000);
      assert.strictEqual(cost, 52.5);
    });
  });
  
  describe('PRICING', () => {
    it('should have Anthropic pricing defined', () => {
      assert.ok(PRICING['anthropic:claude-3-sonnet']);
      assert.strictEqual(PRICING['anthropic:claude-3-sonnet'].input, 3.00);
      assert.strictEqual(PRICING['anthropic:claude-3-sonnet'].output, 15.00);
    });
    
    it('should have Bedrock pricing defined', () => {
      assert.ok(PRICING['bedrock:claude-3-sonnet']);
      assert.strictEqual(PRICING['bedrock:claude-3-sonnet'].input, 3.00);
    });
    
    it('should have OpenAI pricing defined', () => {
      assert.ok(PRICING['openai:gpt-4']);
      assert.strictEqual(PRICING['openai:gpt-4'].input, 30.00);
      assert.strictEqual(PRICING['openai:gpt-4'].output, 60.00);
    });
    
    it('should have Azure pricing defined', () => {
      assert.ok(PRICING['azure:gpt-4']);
      assert.strictEqual(PRICING['azure:gpt-4'].input, 30.00);
    });
  });
  
  describe('getAvailableModels', () => {
    it('should return all providers with their models', () => {
      const models = getAvailableModels();
      assert.ok(models.anthropic);
      assert.ok(models.bedrock);
      assert.ok(models.azure);
      assert.ok(models.openai);
    });
    
    it('should include Claude models for Anthropic', () => {
      const models = getAvailableModels();
      assert.ok(models.anthropic.includes('claude-3-sonnet'));
      assert.ok(models.anthropic.includes('claude-3-opus'));
      assert.ok(models.anthropic.includes('claude-3-haiku'));
      assert.ok(models.anthropic.includes('claude-3-5-sonnet'));
    });
    
    it('should include Claude models for Bedrock', () => {
      const models = getAvailableModels();
      assert.ok(models.bedrock.includes('claude-3-sonnet'));
      assert.ok(models.bedrock.includes('claude-3-opus'));
    });
    
    it('should include GPT models for Azure and OpenAI', () => {
      const models = getAvailableModels();
      assert.ok(models.azure.includes('gpt-4'));
      assert.ok(models.openai.includes('gpt-4'));
      assert.ok(models.openai.includes('gpt-4o'));
      assert.ok(models.openai.includes('o1'));
    });
  });
});

describe('Pricing correctness', () => {
  it('prices dated snapshots as their own family, never a shorter prefix', () => {
    // gpt-4o-mini snapshot must not be priced as gpt-4o ($2.50 in).
    assert.strictEqual(calculateCost('openai', 'gpt-4o-mini-2024-07-18', 1_000_000, 0), 0.15);
    assert.strictEqual(calculateCost('openai', 'gpt-4o-2024-08-06', 1_000_000, 0), 2.5);
    assert.strictEqual(calculateCost('anthropic', 'claude-3-5-sonnet-latest', 1_000_000, 0), 3);
  });

  it('does not borrow a neighbour price for unlisted models', () => {
    for (const model of ['gpt-4.1', 'gpt-4.5-preview', 'o3', 'o1-preview', 'gpt-4-1106-preview']) {
      const r = calculateCostWithStatus('openai', model, 1000, 1000);
      assert.strictEqual(r.costStatus, 'COST_UNAVAILABLE', model);
      assert.strictEqual(r.cost, 0, model);
    }
  });

  it('OpenAI-style usage: cached tokens are inside the input total and are not double charged', () => {
    // 1M prompt tokens of which 400k cached: 600k at $2.50 + 400k at $1.25 = 1.5 + 0.5 = $2.00
    const r = calculateCostWithStatus('openai', 'gpt-4o', 1_000_000, 0, 400_000);
    assert.strictEqual(r.inputCost, 1.5);
    assert.strictEqual(r.cachedInputCost, 0.5);
    assert.strictEqual(r.cost, 2);
  });

  it('cached tokens without a cached price are billed at the input rate (no discount known)', () => {
    // gpt-4 has no cached price: 1M prompt of which 250k cached still costs 1M x $30.
    const r = calculateCostWithStatus('openai', 'gpt-4', 1_000_000, 0, 250_000);
    assert.strictEqual(r.cost, 30);
  });

  it('Anthropic usage: input excludes cache reads/writes, which are billed separately', () => {
    // 100k fresh input $3, 1M cache read at $0.30, 200k cache write at $3.75, 0 output
    const r = calculateCostWithStatus('anthropic', 'claude-3-5-sonnet', 100_000, 0, 1_000_000, 200_000);
    assert.strictEqual(r.inputCost, 0.3);
    assert.strictEqual(r.cachedInputCost, 0.3);
    assert.strictEqual(r.cacheCreationCost, 0.75);
    assert.strictEqual(r.cost, 1.35);
  });
});
