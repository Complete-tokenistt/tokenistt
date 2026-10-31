import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BudgetService } from '../services/budget.js';
import { VirtualKeyService } from '../services/virtualKey.js';
import { InMemoryVirtualKeyStore } from '../services/virtualKey.js';
import { RedisCache } from '../cache/redis.js';
import { AttributionContext } from '../types/index.js';

// Each test gets its own isolated services
function createTestServices() {
  const cache = new RedisCache();
  const store = new InMemoryVirtualKeyStore();
  const virtualKeyService = new VirtualKeyService(cache, store);
  const budgetService = new BudgetService(cache, virtualKeyService, 100);
  return { cache, budgetService };
}

describe('BudgetService', () => {
  it('should reserve budget within limit', async () => {
    const { budgetService } = createTestServices();
    
    const context: AttributionContext = {
      virtualKeyId: `test_${Date.now()}_1`,
      userId: 'user_test',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: `key_${Date.now()}_1`,
      budgetRemaining: 100.00,
      budgetLimit: 100.00,
      rateLimitPerMinute: 100,
    };
    
    const reserved = await budgetService.reserveBudget(context, 50.00);
    assert.strictEqual(reserved, true);
  });
  
  it('should deny reservation exceeding budget', async () => {
    const { budgetService } = createTestServices();
    
    const context: AttributionContext = {
      virtualKeyId: `test_${Date.now()}_2`,
      userId: 'user_test',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: `key_${Date.now()}_2`,
      budgetRemaining: 10.00,
      budgetLimit: 100.00,
      rateLimitPerMinute: 100,
    };
    
    const reserved = await budgetService.reserveBudget(context, 25.00);
    assert.strictEqual(reserved, false);
  });
  
  it('should release reserved budget', async () => {
    const { budgetService } = createTestServices();
    
    const context: AttributionContext = {
      virtualKeyId: `test_${Date.now()}_3`,
      userId: 'user_test',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: `key_${Date.now()}_3`,
      budgetRemaining: 100.00,
      budgetLimit: 100.00,
      rateLimitPerMinute: 100,
    };
    
    await budgetService.reserveBudget(context, 50.00);
    await budgetService.releaseBudget(context, 50.00);
    
    // Should be able to reserve again after release
    const reserved = await budgetService.reserveBudget(context, 50.00);
    assert.strictEqual(reserved, true);
  });
  
  it('should check budget correctly', async () => {
    const { budgetService } = createTestServices();
    
    const context: AttributionContext = {
      virtualKeyId: `test_${Date.now()}_4`,
      userId: 'user_test',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: `key_${Date.now()}_4`,
      budgetRemaining: 100.00,
      budgetLimit: 100.00,
      rateLimitPerMinute: 100,
    };
    
    const result = await budgetService.checkBudget(context, 10.00);
    
    assert.strictEqual(result.estimatedCost, 10.00);
    assert.strictEqual(result.limit, 100.00);
  });
});
