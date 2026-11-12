import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('ops hardening — structure', () => {
  const server = read('src/server.ts');

  it('/health reports 503 when a configured database is unreachable', () => {
    assert.match(server, /res\.status\(healthy \? 200 : 503\)/);
    assert.match(server, /const healthy = dbConnected !== false/);
  });

  it('/ready exists, registered once, and checks Redis when REDIS_REQUIRED=true', () => {
    assert.equal((server.match(/app\.get\(['"`]\/ready['"`]/g) || []).length, 1);
    assert.match(server, /REDIS_REQUIRED === 'true'/);
  });

  it('TRUST_PROXY is wired to express', () => {
    assert.match(server, /app\.set\('trust proxy'/);
  });

  it('shutdown has a force-exit timeout and drops idle connections', () => {
    assert.match(server, /SHUTDOWN_TIMEOUT_MS/);
    assert.match(server, /server\.closeIdleConnections\(\)/);
  });

  it('Redis client never stops retrying', () => {
    const redis = read('src/services/redis.ts');
    const strategy = redis.slice(redis.indexOf('retryStrategy'), redis.indexOf('retryStrategy') + 400);
    assert.doesNotMatch(strategy, /return null/);
  });
});

describe('migrate runner', () => {
  const migrate = readFileSync(join(process.cwd(), '../../packages/db/migrate.mjs'), 'utf-8');
  it('takes an advisory lock and applies each file atomically with its bookkeeping row', () => {
    assert.match(migrate, /pg_advisory_lock/);
    assert.match(migrate, /BEGIN[\s\S]*INSERT INTO schema_migrations[\s\S]*COMMIT/);
    assert.match(migrate, /ROLLBACK/);
  });
});
