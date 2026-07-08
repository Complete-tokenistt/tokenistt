import { describe, it, expect } from 'node:test';
import { calculateCost, PRICING, getAvailableModels } from '../services/pricing.js';

describe('Pricing Service', () => {
  describe('calculateCost', () => {
    it('should calculate cost for Anthropic Claude 3 Sonnet', () => {
      const cost = calculateCost('anthropic', 'claude-3-sonnet', 1000, 500);
      // Input: (1000/1M) * $3.00 = $0.003
      // Output: (500/1M) * $15.00 = $0.0075
      // Total: $0.0105
      expect(cost).toBe(0.0105);
    });
    
    it('should calculate cost for Anthropic Claude 3 Opus', () => {
      const cost = calculateCost('anthropic', 'claude-3-opus', 1000, 500);
      // Input: (1000/1M) * $15.00 = $0.015
      // Output: (500/1M) * $75.00 = $0.0375
      // Total: $0.0525
      expect(cost).toBe(0.0525);
    });
    
    it('should calculate cost for Anthropic Claude 3 Haiku', () => {
      const cost = calculateCost('anthropic', 'claude-3-haiku', 1000, 500);
      // Input: (1000/1M) * $0.25 = $0.00025
      // Output: (500/1M) * $1.25 = $0.000625
      // Total: $0.000875
      expect(cost).toBe(0.000875);
    });
    
    it('should add AWS markup for Bedrock', () => {
      const anthropicCost = calculateCost('anthropic', 'claude-3-sonnet', 1000, 500);
      const bedrockCost = calculateCost('bedrock', 'claude-3-sonnet', 1000, 500);
      
      // Bedrock should be more expensive due to AWS fees
      expect(bedrockCost).toBeGreaterThan(anthropicCost);
    });
    
    it('should use default pricing for unknown models', () => {
      const cost = calculateCost('unknown', 'unknown-model', 1000, 500);
      // Default: $1/M input, $3/M output
      // Input: (1000/1M) * $1.00 = $0.001
      // Output: (500/1M) * $3.00 = $0.0015
      // Total: $0.0025
      expect(cost).toBe(0.0025);
    });
    
    it('should handle zero tokens', () => {
      const cost = calculateCost('anthropic', 'claude-3-sonnet', 0, 0);
      expect(cost).toBe(0);
    });
    
    it('should handle large token counts', () => {
      const cost = calculateCost('anthropic', 'claude-3-opus', 1000000, 500000);
      // Input: 1M tokens * $15.00 = $15.00
      // Output: 500K tokens * $75.00 = $37.50
      // Total: $52.50
      expect(cost).toBe(52.5);
    });
  });
  
  describe('PRICING', () => {
    it('should have Anthropic pricing defined', () => {
      expect(PRICING['anthropic:claude-3-sonnet']).toBeDefined();
      expect(PRICING['anthropic:claude-3-sonnet'].input).toBe(3.00);
      expect(PRICING['anthropic:claude-3-sonnet'].output).toBe(15.00);
    });
    
    it('should have Bedrock pricing defined', () => {
      expect(PRICING['bedrock:claude-3-sonnet']).toBeDefined();
      expect(PRICING['bedrock:claude-3-sonnet'].input).toBe(3.00);
    });
    
    it('should have OpenAI pricing defined', () => {
      expect(PRICING['openai:gpt-4']).toBeDefined();
      expect(PRICING['openai:gpt-4'].input).toBe(30.00);
      expect(PRICING['openai:gpt-4'].output).toBe(60.00);
    });
    
    it('should have Azure pricing defined', () => {
      expect(PRICING['azure:gpt-4']).toBeDefined();
      expect(PRICING['azure:gpt-4'].input).toBe(30.00);
    });
  });
  
  describe('getAvailableModels', () => {
    it('should return all providers with their models', () => {
      const models = getAvailableModels();
      
      expect(models.anthropic).toBeDefined();
      expect(models.bedrock).toBeDefined();
      expect(models.azure).toBeDefined();
      expect(models.openai).toBeDefined();
    });
    
    it('should include Claude models for Anthropic', () => {
      const models = getAvailableModels();
      expect(models.anthropic).toContain('claude-3-sonnet');
      expect(models.anthropic).toContain('claude-3-opus');
      expect(models.anthropic).toContain('claude-3-haiku');
    });
    
    it('should include Claude models for Bedrock', () => {
      const models = getAvailableModels();
      expect(models.bedrock).toContain('claude-3-sonnet');
      expect(models.bedrock).toContain('claude-3-opus');
    });
    
    it('should include GPT models for Azure and OpenAI', () => {
      const models = getAvailableModels();
      expect(models.azure).toContain('gpt-4');
      expect(models.openai).toContain('gpt-4');
    });
  });
});
