import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getClickHouseConfig,
  formatClickHouseRow,
  forwardToClickHouse,
  checkClickHouseHealth,
  getBufferCount,
  clearBuffer,
} from '../services/clickhouse.js';
import type { TransactionEvent } from '../services/eventEmitter.js';

describe('ClickHouse Dual-Write Adapter & Activation Path', () => {
  it('should be disabled by default adhering to Postgres-first principle', () => {
    delete process.env.CLICKHOUSE_ENABLED;
    const config = getClickHouseConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.url, 'http://localhost:8123');
    assert.equal(config.database, 'default');
  });

  it('should format transaction event into typed ClickHouse row', () => {
    const event: TransactionEvent = {
      requestId: 'req-test-999',
      traceId: 'trc-abc',
      organizationId: 101,
      virtualKeyPublicId: 'tktt_live_test123',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      costUsd: 0.003456,
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 800,
      latencyMs: 450,
      status: 'success',
      costStatus: 'ok',
      actor: 'dev-alice',
      costCenter: 'engineering',
      timestamp: '2026-09-11T12:00:00.000Z',
    };

    const row = formatClickHouseRow(event);

    assert.equal(row.organization_id, 101);
    assert.equal(row.actor, 'dev-alice');
    assert.equal(row.provider, 'anthropic');
    assert.equal(row.model, 'claude-3-5-sonnet-20241022');
    assert.equal(row.cost_usd, 0.003456);
    assert.equal(row.prompt_tokens, 1000);
    assert.equal(row.completion_tokens, 200);
    assert.equal(row.total_tokens, 1200);
    assert.equal(row.cache_read_tokens, 800);
    assert.equal(row.duration_ms, 450);
    assert.equal(row.status, 'success');
    assert.equal(row.cost_center, 'engineering');
    assert.ok(row.metadata.includes('tktt_live_test123'));
  });

  it('should be a no-op when ClickHouse is disabled', async () => {
    delete process.env.CLICKHOUSE_ENABLED;
    clearBuffer();

    const event: TransactionEvent = {
      requestId: 'req-noop-1',
      provider: 'openai',
      model: 'gpt-4o',
      costUsd: 0.01,
      inputTokens: 500,
      outputTokens: 100,
      latencyMs: 200,
      status: 'success',
      timestamp: new Date().toISOString(),
    };

    await forwardToClickHouse(event);
    assert.equal(getBufferCount(), 0);
  });

  it('should report health as disabled when not enabled', async () => {
    delete process.env.CLICKHOUSE_ENABLED;
    const health = await checkClickHouseHealth();
    assert.equal(health.enabled, false);
    assert.equal(health.reachable, false);
  });
});

