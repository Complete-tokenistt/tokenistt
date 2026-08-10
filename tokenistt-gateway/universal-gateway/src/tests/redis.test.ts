import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getRedisClient, getCachedVirtualKey, setCachedVirtualKey, invalidateCachedVirtualKey, incrementCachedBudget } from '../services/redis.js';
import { checkSlidingWindowRateLimit } from '../services/redisRateLimiter.js';
import type { AuthContext } from '../db/auth.js';

describe('Redis Cache & Rate Limiting Test Suite', () => {
  let isRedisAvailable = false;

  before(async () => {
    // Attempt to verify Redis client connection
    const client = getRedisClient();
    if (client) {
      try {
        await client.ping();
        isRedisAvailable = true;
        console.log('[Test Setup] Redis is running, enabling full integration tests.');
      } catch (err) {
        console.warn('[Test Setup] Redis is down. Integration tests will verify graceful fail-open behaviors.');
      }
    } else {
      console.warn('[Test Setup] Redis client not initialized. Integration tests will verify graceful fail-open behaviors.');
    }
  });

  after(async () => {
    const client = getRedisClient();
    if (client && isRedisAvailable) {
      await client.quit();
    }
  });

  describe('BigInt JSON Serialization (custom serialize/deserialize)', () => {
    it('should serialize and deserialize AuthContext containing BigInt properties without throwing', async () => {
      const mockContext: AuthContext = {
        virtualKeyId: BigInt(1234567890123456),
        virtualKeyPublicId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        workspaceId: BigInt(9876543210987654),
        organizationId: BigInt(1111111111111111),
        costCenter: 'CC-Engineering-99',
        actor: 'test-user',
        budgetCapUsd: 150.00,
        budgetUsedUsd: 12.3456,
        budgetPeriod: 'monthly',
        allowedProviders: ['openai', 'anthropic'],
        realApiKey: 'sk-proj-testkey',
        enforcementMode: 'hard_cap',
        rateLimitPerMinute: 60,
        rawToken: 'tktt_live_test_user_hash123'
      };

      if (isRedisAvailable) {
        // Cache the key
        await setCachedVirtualKey(mockContext.rawToken!, mockContext, 10);
        
        // Retrieve it
        const retrieved = await getCachedVirtualKey(mockContext.rawToken!);
        assert.ok(retrieved, 'Should retrieve context from Redis cache');
        assert.strictEqual(typeof retrieved.virtualKeyId, 'bigint');
        assert.strictEqual(retrieved.virtualKeyId, mockContext.virtualKeyId);
        assert.strictEqual(retrieved.workspaceId, mockContext.workspaceId);
        assert.strictEqual(retrieved.organizationId, mockContext.organizationId);
        assert.strictEqual(retrieved.budgetCapUsd, mockContext.budgetCapUsd);
        assert.strictEqual(retrieved.budgetUsedUsd, mockContext.budgetUsedUsd);
        assert.strictEqual(retrieved.costCenter, mockContext.costCenter);

        // Invalidate it
        await invalidateCachedVirtualKey(mockContext.rawToken!);
        const afterInvalidation = await getCachedVirtualKey(mockContext.rawToken!);
        assert.strictEqual(afterInvalidation, null, 'Should return null after cache invalidation');
      } else {
        // Graceful fail-open check
        const retrieved = await getCachedVirtualKey('any-token');
        assert.strictEqual(retrieved, null, 'Should return null gracefully when Redis is unavailable');
      }
    });
  });

  describe('Budget Usage Updates', () => {
    it('should increment cached budget correctly', async () => {
      const token = 'tktt_live_budget_test_token';
      const mockContext: AuthContext = {
        virtualKeyId: BigInt(555),
        virtualKeyPublicId: 'uuid-555',
        workspaceId: null,
        organizationId: BigInt(999),
        costCenter: 'CC-Dev',
        actor: 'budget-tester',
        budgetCapUsd: 100,
        budgetUsedUsd: 1.0,
        budgetPeriod: 'daily',
        allowedProviders: [],
        realApiKey: null,
        enforcementMode: 'hard_cap',
        rateLimitPerMinute: 100,
        rawToken: token
      };

      if (isRedisAvailable) {
        // Set initial state in cache
        await setCachedVirtualKey(token, mockContext, 10);

        // Increment budget usage by $0.25
        await incrementCachedBudget(token, 0.25);

        // Retrieve and assert
        const updated = await getCachedVirtualKey(token);
        assert.ok(updated);
        assert.strictEqual(updated.budgetUsedUsd, 1.25);
        
        await invalidateCachedVirtualKey(token);
      } else {
        // Safe execution when offline
        await incrementCachedBudget(token, 0.25);
        assert.ok(true, 'Should not throw when Redis is down');
      }
    });
  });

  describe('Lua-Based Sliding Window Rate Limiter', () => {
    it('should allow requests within limit and deny requests exceeding limit', async () => {
      const keyId = BigInt(998877);
      const limit = 5;
      const windowSeconds = 2;

      if (isRedisAvailable) {
        // Clean up any existing state first
        const client = getRedisClient()!;
        await client.del(`gateway:ratelimit:sliding:${keyId.toString()}`);

        // Make 'limit' requests (5)
        for (let i = 0; i < limit; i++) {
          const status = await checkSlidingWindowRateLimit(keyId, limit, windowSeconds);
          assert.strictEqual(status.allowed, true, `Request ${i + 1} should be allowed`);
          assert.strictEqual(status.remaining, limit - (i + 1));
        }

        // 6th request should exceed the limit
        const statusExceeded = await checkSlidingWindowRateLimit(keyId, limit, windowSeconds);
        assert.strictEqual(statusExceeded.allowed, false, '6th request should be rate-limited');
        assert.strictEqual(statusExceeded.remaining, 0, 'Remaining requests should be 0');

        // Wait for the window to reset
        console.log('Waiting for rate-limit window to expire...');
        await new Promise((resolve) => setTimeout(resolve, (windowSeconds * 1000) + 100));

        // Request after window reset should be allowed
        const statusAfterReset = await checkSlidingWindowRateLimit(keyId, limit, windowSeconds);
        assert.strictEqual(statusAfterReset.allowed, true, 'Request after window expiration should be allowed');
        assert.strictEqual(statusAfterReset.remaining, limit - 1);
      } else {
        // Fail open behavior
        const status = await checkSlidingWindowRateLimit(keyId, limit, windowSeconds);
        assert.strictEqual(status.allowed, true, 'Should fail-open when Redis is down');
        assert.strictEqual(status.remaining, limit);
      }
    });
  });
});
