import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBudgetThreshold } from '../services/budgetEngine.js';

describe('Budget Engine Threshold Evaluation', () => {
  it('allows requests when well under threshold (50% used)', () => {
    const res = evaluateBudgetThreshold(500, 1000, 'hard_cap', 80, 90);
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.action, 'notify');
    assert.strictEqual(res.level, 'ok');
    assert.strictEqual(res.percentUsed, 50);
  });

  it('triggers warn status at 80% utilization', () => {
    const res = evaluateBudgetThreshold(800, 1000, 'hard_cap', 80, 90);
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.action, 'notify');
    assert.strictEqual(res.level, 'warn');
    assert.strictEqual(res.percentUsed, 80);
    assert.ok(res.reason?.includes('warning threshold'));
  });

  it('triggers critical alert at 90% utilization in alert_only mode', () => {
    const res = evaluateBudgetThreshold(900, 1000, 'alert_only', 80, 90);
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.action, 'notify');
    assert.strictEqual(res.level, 'critical');
    assert.strictEqual(res.percentUsed, 90);
  });

  it('triggers auto_throttle action at 90% utilization in auto_throttle mode', () => {
    const res = evaluateBudgetThreshold(920, 1000, 'auto_throttle', 80, 90);
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.action, 'throttle');
    assert.strictEqual(res.level, 'critical');
    assert.strictEqual(res.percentUsed, 92);
  });

  it('blocks request at 100% utilization in hard_cap mode', () => {
    const res = evaluateBudgetThreshold(1000, 1000, 'hard_cap', 80, 90);
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.action, 'block');
    assert.strictEqual(res.level, 'exceeded');
    assert.strictEqual(res.percentUsed, 100);
    assert.ok(res.reason?.includes('Budget cap of $1000.00 exceeded'));
  });

  it('does NOT block request at 100% utilization in alert_only mode', () => {
    const res = evaluateBudgetThreshold(1050, 1000, 'alert_only', 80, 90);
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.action, 'notify');
    assert.strictEqual(res.level, 'exceeded');
  });

  it('handles unlimited cap (cap <= 0) without restriction', () => {
    const res = evaluateBudgetThreshold(5000, 0, 'hard_cap');
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.level, 'ok');
  });
});

