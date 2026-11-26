import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { calculateCostWithStatus, PRICING, resolvePricing } from '../services/pricing.js';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(here, '../../../../packages/db/drizzle/0015_anthropic_catalog_current.sql'),
  'utf8',
);

// ('anthropic', 'model', 'Name', ctx, maxOut, input, cacheWrite, cacheHit, output, 'active', 'date')
const rowRe = /\('anthropic',\s*'([^']+)',\s*'[^']+',\s*(?:\d+|NULL),\s*(?:\d+|NULL),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),/g;
const rows = [...migration.matchAll(rowRe)].map(m => ({
  model: m[1], input: +m[2], cacheWrite: +m[3], cachedInput: +m[4], output: +m[5],
}));

describe('Current Anthropic catalog (migration 0015)', () => {
  it('parses every seeded row', () => {
    assert.strictEqual(rows.length, 17);
  });

  it('fallback table matches the migration row for row, so offline pricing never drifts from Postgres', () => {
    for (const r of rows) {
      const tier = PRICING[`anthropic:${r.model}`];
      assert.ok(tier, `pricing.ts is missing anthropic:${r.model}`);
      assert.deepStrictEqual(
        { input: tier.input, output: tier.output, cachedInput: tier.cachedInput, cacheWrite: tier.cacheWrite },
        { input: r.input, output: r.output, cachedInput: r.cachedInput, cacheWrite: r.cacheWrite },
        r.model,
      );
    }
  });

  it('prices a dated snapshot at its alias (claude-haiku-4-5-20251001 -> claude-haiku-4-5)', () => {
    assert.deepStrictEqual(resolvePricing('anthropic', 'claude-haiku-4-5-20251001'), PRICING['anthropic:claude-haiku-4-5']);
  });

  it('bills Opus 5.5 cache hits at 0.05x input ($0.20/M), not 0.1x', () => {
    // 1M uncached input $4 + 1M cache hits $0.20 + 1M cache writes $5 + 1M output $20 = $29.20
    const r = calculateCostWithStatus('anthropic', 'claude-opus-5-5', 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    assert.strictEqual(r.costStatus, 'ok');
    assert.strictEqual(r.cost, 29.2);
  });

  it('leaves claude-haiku-5-5 unpriced: its price depends on prompt length', () => {
    const r = calculateCostWithStatus('anthropic', 'claude-haiku-5-5', 1000, 500);
    assert.strictEqual(r.costStatus, 'COST_UNAVAILABLE');
    assert.strictEqual(r.cost, 0);
  });
});
