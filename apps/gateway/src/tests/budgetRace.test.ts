import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { 
  atomicBudgetReserve, 
  adjustBudgetReservation 
} from '../services/redis.js';

describe('Phase 1 — Concurrency & Atomic Budget Reservation', () => {
  test('atomicBudgetReserve handles period "none" without blocking', async () => {
    const res = await atomicBudgetReserve('tktt_live_test_user_hash', 10.0, 50.0, 'none');
    assert.equal(res.allowed, true);
  });

  test('adjustBudgetReservation handles small delta gracefully without throwing', async () => {
    await assert.doesNotReject(async () => {
      await adjustBudgetReservation('tktt_live_test_user_hash', 0.01, 0.0100001, 'monthly');
    });
  });

  test('adjustBudgetReservation handles period "none" gracefully', async () => {
    await assert.doesNotReject(async () => {
      await adjustBudgetReservation('tktt_live_test_user_hash', 0.05, 0.08, 'none');
    });
  });
});

