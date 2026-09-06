import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSpendAnomaly,
  evaluateTokenAnomaly,
  evaluateModelShiftAnomaly,
} from '../services/anomalyDetector.js';

describe('Anomaly Detector Engine', () => {
  describe('Spend Anomaly', () => {
    it('does not flag when spend is within normal range (2x)', () => {
      const result = evaluateSpendAnomaly(200, 100);
      assert.strictEqual(result.detected, false);
      assert.strictEqual(result.severity, 'info');
      assert.strictEqual(result.ratio, 2.0);
    });

    it('flags warning when spend reaches 3x normal baseline', () => {
      const result = evaluateSpendAnomaly(300, 100);
      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.severity, 'warn');
      assert.strictEqual(result.ratio, 3.0);
      assert.ok(result.message.includes('3.0×'));
    });

    it('flags critical when spend reaches 5x normal baseline', () => {
      const result = evaluateSpendAnomaly(520, 100);
      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.severity, 'critical');
      assert.strictEqual(result.ratio, 5.2);
    });

    it('handles zero or negative baseline gracefully without false positive', () => {
      const result = evaluateSpendAnomaly(50, 0);
      assert.strictEqual(result.detected, false);
    });
  });

  describe('Token Anomaly', () => {
    it('does not flag normal token sizes (2x)', () => {
      const result = evaluateTokenAnomaly(4000, 2000);
      assert.strictEqual(result.detected, false);
      assert.strictEqual(result.ratio, 2.0);
    });

    it('flags token spike when average tokens/request jumps 5x', () => {
      const result = evaluateTokenAnomaly(10000, 2000);
      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.severity, 'warn');
      assert.strictEqual(result.ratio, 5.0);
    });

    it('flags critical token spike when average tokens/request jumps 10x', () => {
      const result = evaluateTokenAnomaly(25000, 2000);
      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.severity, 'critical');
      assert.strictEqual(result.ratio, 12.5);
    });
  });

  describe('Model Shift Anomaly', () => {
    it('does not flag small or normal variations', () => {
      const result = evaluateModelShiftAnomaly(0.15, 0.10);
      assert.strictEqual(result.detected, false);
    });

    it('flags when expensive model share jumps 2x and represents significant portion', () => {
      const result = evaluateModelShiftAnomaly(0.45, 0.20);
      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.severity, 'warn');
    });

    it('flags critical when expensive model share jumps 3x', () => {
      const result = evaluateModelShiftAnomaly(0.65, 0.20);
      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.severity, 'critical');
    });
  });
});

