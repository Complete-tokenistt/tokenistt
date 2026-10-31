import { describe, it } from 'node:test';
import assert from 'node:assert';
import { metrics } from '../services/metrics.js';

describe('Prometheus Metrics Exporter', () => {
  it('should format metrics in standard Prometheus text exposition format', () => {
    metrics.recordTransaction({
      provider: 'openai',
      model: 'gpt-4o',
      status: 'success',
      costCenter: 'CC-AI-Lab',
      costUsd: 0.0075,
      promptTokens: 1000,
      completionTokens: 500,
      latencyMs: 120,
    });

    const output = metrics.getMetricsText();
    assert.ok(output.includes('# HELP tokenistt_requests_total'));
    assert.ok(output.includes('# TYPE tokenistt_requests_total counter'));
    assert.ok(output.includes('provider="openai"'));
    assert.ok(output.includes('model="gpt-4o"'));
    assert.ok(output.includes('tokenistt_cost_usd_total'));
    assert.ok(output.includes('tokenistt_tokens_prompt_total'));
  });
});

