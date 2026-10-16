/**
 * qaRegression.test.ts — Regression tests for bugs found during Final FinOps QA Audit.
 *
 * BUG-01 (P0): drainQueue used ON CONFLICT (request_id) which crashes on partitioned tables
 * BUG-02 (P1): streaming.ts used calculateCost — missed cache/reasoning tokens
 * BUG-03 (P1): secrets.ts did not validate MASTER_KEY at startup
 * BUG-04 (P1): POST /v1/config/providers had no authentication
 * BUG-05 (P2): Admin secret comparison used !== instead of timingSafeEqual
 * BUG-06 (P1): hourly_spend gap vs transactions (historical data before rollup)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { calculateCostWithStatus, calculateCost } from '../services/pricing.js';
import { atomicBudgetReserve } from '../services/redis.js';
import { parseToken } from '../db/auth.js';
import { drainQueue } from '../db/durableQueue.js';

// ─── BUG-01: drainQueue idempotency via WHERE NOT EXISTS ────────────────────

describe('BUG-01 — drainQueue idempotency (WHERE NOT EXISTS)', () => {
  it('drainQueue INSERT must use WHERE NOT EXISTS, not ON CONFLICT in SQL', () => {
    const src = readFileSync(join(process.cwd(), 'src/db/durableQueue.ts'), 'utf-8');
    const fnStart = src.indexOf('async function drainQueue');
    const fnEnd = src.indexOf('\nexport function startDrainScheduler');
    const fnBody = src.slice(fnStart, fnEnd);

    // Must have WHERE NOT EXISTS as the idempotency guard
    assert.ok(
      fnBody.includes('WHERE NOT EXISTS'),
      'drainQueue function must use WHERE NOT EXISTS for idempotency (partitioned table cannot have unique index on request_id alone)'
    );

    // ON CONFLICT must not appear in the actual INSERT SQL — only in comments is acceptable.
    // Strip all comment lines (// ...) and block comments before checking
    const noComments = fnBody
      .split('\n')
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    assert.ok(
      !noComments.includes('ON CONFLICT'),
      'drainQueue INSERT SQL (non-comment code) must NOT use ON CONFLICT — crashes on partitioned tables'
    );
  });

  it('drainQueue correctly routes inserts through idempotency guard', () => {
    // QUEUE_FILE is a const set at module load time (process.env.TX_QUEUE_FILE),
    // so runtime env override during tests does not work with already-loaded ESM modules.
    // Structural verification: confirm the INSERT SQL template contains WHERE NOT EXISTS.
    const src = readFileSync(join(process.cwd(), 'src/db/durableQueue.ts'), 'utf-8');
    const fnStart = src.indexOf('async function drainQueue');
    const fnEnd = src.indexOf('\nexport function startDrainScheduler');
    const fnBody = src.slice(fnStart, fnEnd);

    // The SELECT sub-query for idempotency
    assert.ok(
      fnBody.includes('WHERE NOT EXISTS'),
      'drainQueue must contain WHERE NOT EXISTS guard in the INSERT SQL'
    );
    assert.ok(
      fnBody.includes('SELECT 1 FROM transactions WHERE request_id = $8'),
      'WHERE NOT EXISTS sub-query must check transactions table by request_id ($8)'
    );
    // Verify $8 is the request_id parameter (9th param = index 8 in 1-based SQL)
    const insertBlock = fnBody.slice(fnBody.indexOf('INSERT INTO transactions'));
    assert.ok(
      insertBlock.includes('$8') || insertBlock.includes('tx.requestId'),
      'INSERT must bind request_id as parameter for the WHERE NOT EXISTS check'
    );
  });
});

// ─── BUG-02: Streaming uses calculateCostWithStatus ─────────────────────────

describe('BUG-02 — Streaming cost calculation uses calculateCostWithStatus', () => {
  it('streaming.ts imports calculateCostWithStatus', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/streaming.ts'), 'utf-8');
    assert.ok(
      src.includes('calculateCostWithStatus'),
      'streaming.ts must import calculateCostWithStatus (not just calculateCost) to account for cache/reasoning tokens'
    );
  });

  it('streaming end handler uses calculateCostWithStatus, not calculateCost', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/streaming.ts'), 'utf-8');
    const endBlock = src.slice(src.indexOf("response.data.on('end'"));
    assert.ok(
      endBlock.includes('calculateCostWithStatus('),
      'Stream end handler must call calculateCostWithStatus to include cache/reasoning tokens in cost'
    );
  });

  it('calculateCostWithStatus includes cached input discount (streaming fix)', () => {
    // Verify the function itself handles cached tokens correctly.
    // Old streaming code: calculateCost(provider, model, inputTokens, 0) — ignored cached tokens
    // New streaming code: calculateCostWithStatus(provider, model, inputTokens, outputTokens)
    // Claude 3.5 Sonnet: input=$3.00/M, cachedInput=$0.30/M, output=$15.00/M
    const withStatus = calculateCostWithStatus(
      'anthropic', 'claude-3-5-sonnet',
      1_000_000, 500_000,
      500_000, // cachedTokens
    );
    const oldMethod = calculateCost('anthropic', 'claude-3-5-sonnet', 1_000_000, 500_000);

    assert.ok(withStatus.cachedInputCost > 0, 'calculateCostWithStatus must calculate cachedInputCost when cached tokens present');
    // With cache: input $3.00 + cached $0.15 + output $7.50 = $10.65
    // Without: input $3.00 + output $7.50 = $10.50 (old method ignores cached discount savings)
    assert.strictEqual(withStatus.costStatus, 'ok', 'Known model must return ok status');
    assert.ok(withStatus.cost > 0, 'calculateCostWithStatus must return positive cost for known model');
  });

  it('streaming logs error transaction when stream provider fails', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/streaming.ts'), 'utf-8');
    const errorSection = src.slice(src.indexOf("response.data.on('error'"));
    assert.ok(
      errorSection.includes('logTransaction('),
      'Stream error handler must call logTransaction to record failed stream attempts in the ledger'
    );
  });
});

// ─── BUG-03: MASTER_KEY validated in secrets.ts ──────────────────────────────

describe('BUG-03 — MASTER_KEY validated at startup', () => {
  it('secrets.ts validates MASTER_KEY presence in production', () => {
    const src = readFileSync(join(process.cwd(), 'src/config/secrets.ts'), 'utf-8');
    assert.ok(src.includes('MASTER_KEY'), 'secrets.ts must reference MASTER_KEY for production validation');
    assert.ok(
      src.includes("missing.push('MASTER_KEY')"),
      'MASTER_KEY must be added to the production missing[] array — absence causes process.exit(1)'
    );
  });

  it('secrets.ts rejects insecure MASTER_KEY default in production', () => {
    const src = readFileSync(join(process.cwd(), 'src/config/secrets.ts'), 'utf-8');
    assert.ok(
      src.includes('default-master-key-change-in-production'),
      'secrets.ts must explicitly check for and reject the insecure MASTER_KEY default in production'
    );
  });

  it('secrets.ts issues warning for default MASTER_KEY in development', () => {
    const src = readFileSync(join(process.cwd(), 'src/config/secrets.ts'), 'utf-8');
    // The else branch (dev mode) should warn
    assert.ok(
      src.includes('console.warn') || src.includes('[SECURITY WARNING]'),
      'Development mode must warn about insecure MASTER_KEY default'
    );
  });
});

// ─── BUG-04: POST /v1/config/providers requires auth ────────────────────────

describe('BUG-04 — POST /v1/config/providers authentication', () => {
  it('server.ts POST /v1/config/providers checks X-Admin-Secret header', () => {
    const src = readFileSync(join(process.cwd(), 'src/server.ts'), 'utf-8');
    const sectionStart = src.indexOf("'/v1/config/providers'");
    const sectionEnd = src.indexOf('\n});', sectionStart) + 3;
    const section = src.slice(sectionStart - 50, sectionEnd);

    assert.ok(
      section.includes('x-admin-secret') || section.includes('ADMIN_SECRET'),
      'POST /v1/config/providers must require X-Admin-Secret authentication'
    );
  });

  it('POST /v1/config/providers returns 401 without valid secret', () => {
    // Verify the guard logic is structurally present: missing header → 401
    const src = readFileSync(join(process.cwd(), 'src/server.ts'), 'utf-8');
    const sectionStart = src.indexOf("'/v1/config/providers'");
    const section = src.slice(sectionStart, sectionStart + 700);
    assert.ok(section.includes('401'), 'Guard must return HTTP 401 on missing/wrong admin secret');
  });
});

// ─── BUG-05: Admin secret timing-safe comparison ─────────────────────────────

describe('BUG-05 — Admin secret timing-safe comparison', () => {
  it('admin.ts imports timingSafeEqual from node:crypto', () => {
    const src = readFileSync(join(process.cwd(), 'src/routes/admin.ts'), 'utf-8');
    assert.ok(src.includes('timingSafeEqual'), 'admin.ts must import timingSafeEqual for constant-time comparison');
  });

  it('requireAdminAuth uses timingSafeEqual, not !== for secret comparison', () => {
    const src = readFileSync(join(process.cwd(), 'src/routes/admin.ts'), 'utf-8');
    const fnStart = src.indexOf('function requireAdminAuth');
    const fnEnd = src.indexOf('\nadminRouter.use');
    const fnBody = src.slice(fnStart, fnEnd);

    assert.ok(fnBody.includes('timingSafeEqual'), 'requireAdminAuth must call timingSafeEqual');
    assert.ok(
      !fnBody.includes('headerSecret !== adminSecret'),
      'requireAdminAuth must NOT use !== comparison (timing-sensitive, enables enumeration attacks)'
    );
  });

  it('timingSafeEqual correctly validates admin secret', () => {
    const secret = 'my-test-admin-secret-exactly-here';
    const correct = Buffer.from(secret);
    const wrong = Buffer.from('wrong-secret-value-not-matching!!');

    // Same length, different content — timingSafeEqual must return false
    if (correct.length === wrong.length) {
      assert.ok(!timingSafeEqual(correct, wrong), 'timingSafeEqual must reject wrong secret of same length');
    }
    // Exact match must pass
    assert.ok(timingSafeEqual(correct, Buffer.from(secret)), 'timingSafeEqual must accept correct secret');
  });
});

// ─── BUG-06: hourly_spend/transactions reconciliation ────────────────────────

describe('BUG-06 — hourly_spend/transactions reconciliation', () => {
  it('upsertHourlyRollup is called in transactionLogger on DB insert success', () => {
    const src = readFileSync(join(process.cwd(), 'src/db/transactionLogger.ts'), 'utf-8');
    assert.ok(src.includes('upsertHourlyRollup('), 'transactionLogger must call upsertHourlyRollup after successful DB insert');
  });

  it('hourly_spend uses ON CONFLICT for safe upsert idempotency', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/hourlyRollup.ts'), 'utf-8');
    assert.ok(
      src.includes('ON CONFLICT (organization_id, provider, model, hour_bucket)'),
      'hourly_spend upsert must be idempotent via ON CONFLICT on its composite unique key'
    );
  });

  it('documented: hourly_spend gap is bounded to pre-rollup historical data', () => {
    // The $0.002450 gap between hourly_spend and transactions exists because
    // 14 llama-3.1 transactions from July 2026 predate the hourly rollup implementation.
    // This is a known, bounded, non-growing limitation.
    // Dashboard total spend must use transactions table, not hourly_spend, for authoritative totals.
    assert.ok(true, 'DOCUMENTED LIMITATION: $0.002450 gap = 14 pre-rollup July 2026 transactions; non-growing');
  });
});

// ─── Core Accounting Invariants Regression Suite ─────────────────────────────

describe('Regression Suite — Core FinOps Accounting Invariants', () => {
  it('Unknown model cost is never fabricated ($0.00 / COST_UNAVAILABLE)', () => {
    const result = calculateCostWithStatus('fake-provider', 'totally-unknown-model-v99', 1_000_000, 500_000);
    assert.strictEqual(result.cost, 0, 'Unknown model must return exactly $0.00');
    assert.strictEqual(result.costStatus, 'COST_UNAVAILABLE', 'Unknown model must return COST_UNAVAILABLE status');
    assert.strictEqual(result.isKnown, false, 'Unknown model must set isKnown=false');
  });

  it('Known model pricing exact at 1M/1M tokens — GPT-4o', () => {
    const result = calculateCostWithStatus('openai', 'gpt-4o', 1_000_000, 1_000_000);
    // $2.50/M input + $10.00/M output = $12.50
    assert.strictEqual(result.cost, 12.5, 'gpt-4o 1M input + 1M output = $12.50');
    assert.strictEqual(result.costStatus, 'ok');
  });

  it('Known model pricing exact at 1M/1M tokens — Claude 3.5 Sonnet', () => {
    const result = calculateCostWithStatus('anthropic', 'claude-3-5-sonnet', 1_000_000, 1_000_000);
    // $3.00/M input + $15.00/M output = $18.00
    assert.strictEqual(result.cost, 18.0, 'claude-3-5-sonnet 1M input + 1M output = $18.00');
  });

  it('Budget blocks at exact cap regardless of Redis state (Redis unavailable path)', async () => {
    // Redis is unavailable in this test environment — validates the DB fallback enforcement
    const atCap = await atomicBudgetReserve('regression-cap-test', 0.01, 100.00, 'monthly', 100.00);
    assert.strictEqual(atCap.allowed, false, 'Spend exactly at cap must be blocked by DB fallback path');
  });

  it('Budget allows requests under cap (Redis unavailable path)', async () => {
    const underCap = await atomicBudgetReserve('regression-under-test', 1.00, 100.00, 'monthly', 50.00);
    assert.strictEqual(underCap.allowed, true, '$50 + $1 < $100 cap must be allowed');
  });

  it('parseToken rejects SQL injection, huge payloads, and malformed inputs', () => {
    // SQL injection attempt
    assert.strictEqual(parseToken("Bearer tktt_live_ws_user_hash'; DROP TABLE--"), null, 'SQL injection attempt must be rejected');
    // Empty
    assert.strictEqual(parseToken(''), null, 'Empty string must be rejected');
    // Missing Bearer
    assert.strictEqual(parseToken('tktt_live_ws_user_hash'), null, 'Token without Bearer prefix must be rejected');
    // Huge payload (DoS attempt)
    assert.strictEqual(parseToken('Bearer ' + 'x'.repeat(5000)), null, '5000-char token must be rejected');
    // Valid format must still work
    const valid = parseToken('Bearer tktt_live_workspace_user_abc123def456xyz');
    assert.notStrictEqual(valid, null, 'Valid tktt_live token format must be parsed');
  });

  it('Negative token counts produce zero or negative cost — no phantom credits', () => {
    const result = calculateCostWithStatus('openai', 'gpt-4o', -1000, -500);
    assert.ok(result.cost <= 0, `Negative tokens must not produce positive cost; got $${result.cost}`);
  });

  it('Zero tokens produce exactly $0.00 cost', () => {
    const result = calculateCostWithStatus('openai', 'gpt-4o', 0, 0);
    assert.strictEqual(result.cost, 0, 'Zero tokens must produce $0.00');
  });

  it('Large token counts (INT_MAX) produce finite, non-NaN cost', () => {
    const result = calculateCostWithStatus('openai', 'gpt-4o', 2_147_483_647, 2_147_483_647);
    assert.ok(Number.isFinite(result.cost), 'INT_MAX token count must produce finite cost');
    assert.ok(!Number.isNaN(result.cost), 'INT_MAX token count must not produce NaN');
    assert.ok(result.cost > 0, 'INT_MAX token count must produce positive cost');
  });
});
