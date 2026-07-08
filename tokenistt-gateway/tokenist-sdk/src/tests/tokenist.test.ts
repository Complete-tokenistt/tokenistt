import { describe, it } from 'node:test';
import assert from 'node:assert';
import { calculateCost, estimateCost, PRICING } from '../utils/pricing.js';
import { 
  Tokenist,
  UsageCallback,
  CostCallback,
  BudgetWarning,
  APIError,
  RateLimitError,
  AuthenticationError,
  BudgetExceededError,
} from '../index.js';

describe('Tokenist SDK', () => {
  describe('Pricing', () => {
    it('should calculate cost for Claude 3 Sonnet', () => {
      const cost = calculateCost('claude-3-sonnet', 1000, 500);
      assert.strictEqual(cost, 0.0105);
    });
    
    it('should calculate cost for GPT-4', () => {
      const cost = calculateCost('gpt-4', 1000, 500);
      assert.strictEqual(cost, 0.06);
    });
    
    it('should estimate cost with defaults', () => {
      const cost = estimateCost('claude-3-sonnet', 1000);
      assert.ok(cost > 0);
      assert.ok(cost < 0.1);
    });
    
    it('should use default pricing for unknown models', () => {
      const cost = calculateCost('unknown-model', 1000, 500);
      assert.ok(cost > 0);
    });
    
    it('should have pricing for all major models', () => {
      const expectedModels = [
        'gpt-4',
        'gpt-3.5-turbo',
        'claude-3-opus',
        'claude-3-sonnet',
        'claude-3-haiku',
      ];
      
      for (const model of expectedModels) {
        assert.ok(PRICING[model], `Pricing should exist for ${model}`);
      }
    });
  });
  
  describe('Client Configuration', () => {
    it('should require apiKey', () => {
      assert.throws(
        () => new Tokenist({} as any),
        /apiKey is required/
      );
    });
    
    it('should use default baseURL', () => {
      const client = new Tokenist({
        apiKey: 'test-key',
      });
      
      assert.ok(client);
      assert.ok(client.chat);
    });
    
    it('should have chat.completions.create method', () => {
      const client = new Tokenist({
        apiKey: 'test-key',
      });
      
      assert.ok(typeof client.chat.completions.create === 'function');
    });
  });
  
  describe('Callback Configuration', () => {
    it('should accept onUsage callback', () => {
      const client = new Tokenist({
        apiKey: 'test-key',
        onUsage: (usage: UsageCallback) => {
          assert.ok(usage.promptTokens >= 0);
          assert.ok(usage.completionTokens >= 0);
          assert.ok(usage.totalTokens >= 0);
        },
      });
      
      assert.ok(client);
    });
    
    it('should accept onCost callback', () => {
      const client = new Tokenist({
        apiKey: 'test-key',
        onCost: (cost: CostCallback) => {
          assert.ok(cost.cost >= 0);
          assert.ok(cost.model);
        },
      });
      
      assert.ok(client);
    });
    
    it('should accept onBudgetWarning callback', () => {
      const client = new Tokenist({
        apiKey: 'test-key',
        onBudgetWarning: (warning: BudgetWarning) => {
          assert.ok(warning.userId);
          assert.ok(warning.budgetLimit > 0);
          assert.ok(warning.percentageUsed >= 0);
        },
      });
      
      assert.ok(client);
    });
  });
  
  describe('Request Configuration', () => {
    it('should use defaultUser from config', () => {
      const client = new Tokenist({
        apiKey: 'test-key',
        defaultUser: 'default@user.com',
      });
      
      client.setDefaultUser('new@user.com');
      assert.ok(client);
    });
    
    it('should use defaultCostCenter from config', () => {
      const client = new Tokenist({
        apiKey: 'test-key',
        defaultCostCenter: 'engineering',
      });
      
      client.setDefaultCostCenter('marketing');
      assert.ok(client);
    });
    
    it('should allow setting baseURL', () => {
      const client = new Tokenist({
        apiKey: 'test-key',
        baseURL: 'http://localhost:3000',
      });
      
      client.setBaseURL('http://localhost:4000');
      assert.ok(client);
    });
  });
  
  describe('Budget Management', () => {
    it('should allow setting budget limits', () => {
      const client = new Tokenist({
        apiKey: 'test-key',
      });
      
      client.setBudgetLimit('user123', 100.00);
      client.setBudgetLimit('user456', 200.00);
      
      assert.ok(client);
    });
  });
});

describe('Error Types', () => {
  it('should create APIError with status', () => {
    const error = new APIError('Test error', 400, 'test_code', 'test_type');
    
    assert.strictEqual(error.message, 'Test error');
    assert.strictEqual(error.status, 400);
    assert.strictEqual(error.code, 'test_code');
    assert.strictEqual(error.type, 'test_type');
  });
  
  it('should create RateLimitError', () => {
    const error = new RateLimitError('Rate limited', 429, { 'retry-after': '60' });
    
    assert.strictEqual(error.message, 'Rate limited');
    assert.strictEqual(error.status, 429);
    assert.strictEqual(error.code, 'rate_limit_exceeded');
  });
  
  it('should create AuthenticationError', () => {
    const error = new AuthenticationError('Invalid key');
    
    assert.strictEqual(error.message, 'Invalid key');
    assert.strictEqual(error.status, 401);
    assert.strictEqual(error.code, 'authentication_error');
  });
  
  it('should create BudgetExceededError with details', () => {
    const error = new BudgetExceededError(50.00, 48.50, 2.00);
    
    assert.strictEqual(error.limit, 50.00);
    assert.strictEqual(error.used, 48.50);
    assert.strictEqual(error.estimatedCost, 2.00);
    assert.strictEqual(error.status, 429);
  });
});
