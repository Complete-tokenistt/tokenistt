import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { RedisCache } from '../cache/redis.js';
import { RateLimiterService } from '../services/rateLimiter.js';
import { AttributionContext } from '../types/index.js';

describe('RateLimiterService', () => {
  let cache: RedisCache;
  let rateLimiter: RateLimiterService;
  
  beforeEach(() => {
    cache = new RedisCache();
    rateLimiter = new RateLimiterService(cache, 10, 60); // 10 req/min for testing
  });
  
  it('should allow first request', async () => {
    const context: AttributionContext = {
      virtualKeyId: 'test_key_1',
      userId: 'user_1',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: 'test_key',
      budgetRemaining: 100,
      budgetLimit: 100,
      rateLimitPerMinute: 10,
    };
    
    const result = await rateLimiter.checkRateLimit(context);
    
    assert.ok(result.allowed);
    assert.strictEqual(result.remaining, 9);
    assert.ok(result.resetAt > Date.now() / 1000);
  });
  
  it('should decrement remaining count', async () => {
    const context: AttributionContext = {
      virtualKeyId: 'test_key_2',
      userId: 'user_2',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: 'test_key',
      budgetRemaining: 100,
      budgetLimit: 100,
      rateLimitPerMinute: 10,
    };
    
    // Make several requests
    await rateLimiter.checkRateLimit(context);
    await rateLimiter.checkRateLimit(context);
    await rateLimiter.checkRateLimit(context);
    
    const result = await rateLimiter.checkRateLimit(context);
    
    assert.ok(result.allowed);
    assert.strictEqual(result.remaining, 6);
  });
  
  it('should deny when limit exceeded', async () => {
    const context: AttributionContext = {
      virtualKeyId: 'test_key_3',
      userId: 'user_3',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: 'test_key',
      budgetRemaining: 100,
      budgetLimit: 100,
      rateLimitPerMinute: 5, // Low limit for testing
    };
    
    // Exhaust the limit
    for (let i = 0; i < 5; i++) {
      await rateLimiter.checkRateLimit(context);
    }
    
    const result = await rateLimiter.checkRateLimit(context);
    
    assert.ok(!result.allowed);
    assert.strictEqual(result.remaining, 0);
    assert.ok(result.retryAfter);
  });
  
  it('should use default limit when context limit not set', async () => {
    const context: AttributionContext = {
      virtualKeyId: 'test_key_4',
      userId: 'user_4',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: 'test_key',
      budgetRemaining: 100,
      budgetLimit: 100,
      rateLimitPerMinute: 0, // Not set
    };
    
    const result = await rateLimiter.checkRateLimit(context);
    
    assert.ok(result.allowed);
    // Should use default of 10
    assert.strictEqual(result.remaining, 9);
  });
  
  it('should get rate limit status without incrementing', async () => {
    const context: AttributionContext = {
      virtualKeyId: 'test_key_5',
      userId: 'user_5',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: 'test_key',
      budgetRemaining: 100,
      budgetLimit: 100,
      rateLimitPerMinute: 10,
    };
    
    // Make a request to consume one
    await rateLimiter.checkRateLimit(context);
    
    // Check status without incrementing
    const status = await rateLimiter.getRateLimitStatus(context);
    
    assert.strictEqual(status.remaining, 9);
    assert.ok(status.allowed);
  });
  
  it('should reset rate limit', async () => {
    const context: AttributionContext = {
      virtualKeyId: 'test_key_6',
      userId: 'user_6',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: 'test_key',
      budgetRemaining: 100,
      budgetLimit: 100,
      rateLimitPerMinute: 10,
    };
    
    // Consume some requests
    await rateLimiter.checkRateLimit(context);
    await rateLimiter.checkRateLimit(context);
    
    // Reset
    await rateLimiter.resetRateLimit(context);
    
    // Check status - should be back to full
    const status = await rateLimiter.getRateLimitStatus(context);
    assert.strictEqual(status.remaining, 10);
  });
  
  it('should track different keys independently', async () => {
    const context1: AttributionContext = {
      virtualKeyId: 'test_key_7',
      userId: 'user_7',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: 'test_key',
      budgetRemaining: 100,
      budgetLimit: 100,
      rateLimitPerMinute: 5,
    };
    
    const context2: AttributionContext = {
      virtualKeyId: 'test_key_8',
      userId: 'user_8',
      workspace: 'test',
      costCenter: 'testing',
      realApiKey: 'test_key',
      budgetRemaining: 100,
      budgetLimit: 100,
      rateLimitPerMinute: 5,
    };
    
    // Exhaust key 1
    for (let i = 0; i < 5; i++) {
      await rateLimiter.checkRateLimit(context1);
    }
    
    // Key 2 should still have capacity
    const result = await rateLimiter.checkRateLimit(context2);
    assert.ok(result.allowed);
    assert.strictEqual(result.remaining, 4);
  });
  
  it('should return correct config', () => {
    const config = rateLimiter.getConfig();
    assert.strictEqual(config.defaultLimit, 10);
    assert.strictEqual(config.windowSeconds, 60);
  });
});
