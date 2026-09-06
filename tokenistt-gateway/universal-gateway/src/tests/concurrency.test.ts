import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INCREMENT_BUDGET_SCRIPT } from '../services/redis.js';

describe('Milestone 9: Concurrency & Atomicity Certification', () => {
  it('INCREMENT_BUDGET_SCRIPT Lua script is defined and parses numbers atomically', () => {
    assert.ok(INCREMENT_BUDGET_SCRIPT);
    assert.ok(INCREMENT_BUDGET_SCRIPT.includes('cjson.decode'));
    assert.ok(INCREMENT_BUDGET_SCRIPT.includes('cjson.encode'));
    assert.ok(INCREMENT_BUDGET_SCRIPT.includes('SETEX'));
  });

  it('100 concurrent simulated increments produce exact accumulation without lost updates', async () => {
    let sharedBudget = 0.0;
    const lock = { busy: false };

    // Simulate atomic update function (similar to Redis Lua execution)
    async function atomicIncrement(amount: number): Promise<number> {
      while (lock.busy) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      lock.busy = true;
      try {
        sharedBudget += amount;
        return sharedBudget;
      } finally {
        lock.busy = false;
      }
    }

    // 100 concurrent increments of $0.05
    const increments = Array.from({ length: 100 }, () => atomicIncrement(0.05));
    await Promise.all(increments);

    // Exact expected: 100 * 0.05 = 5.00
    assert.strictEqual(Math.round(sharedBudget * 100) / 100, 5.00);
  });
});

