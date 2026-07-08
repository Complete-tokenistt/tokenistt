import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calculateCost, PRICING, getAvailableModels } from '../services/pricing.js';

describe('Pricing Service', () => {
  describe('calculateCost', () => {
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
    });
  });
});
