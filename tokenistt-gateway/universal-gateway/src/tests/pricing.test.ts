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
    
    it('should add AWS markup for Bedrock', () => {
      const anthropicCost = calculateCost('anthropic', 'claude-3-sonnet', 1000, 500);
      const bedrockCost = calculateCost('bedrock', 'claude-3-sonnet', 1000, 500);
      assert.ok(bedrockCost > anthropicCost);
    });
    
    it('should use default pricing for unknown models', () => {
      const cost = calculateCost('unknown', 'unknown-model', 1000, 500);
      assert.strictEqual(cost, 0.0025);
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
