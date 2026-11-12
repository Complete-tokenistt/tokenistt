import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPartitionNameForDate,
  getPartitionRange,
  ensurePartitionsAhead,
  ensurePartitionForDate,
  startPartitionMaintenanceScheduler,
  stopPartitionMaintenanceScheduler,
  selectExpiredPartitions,
  dropExpiredPartitions,
} from '../services/partitionManager.js';
import { setMockPool } from '../db/pool.js';

describe('Partition Manager Service', () => {
  it('should format partition names accurately based on UTC year and month', () => {
    const d1 = new Date(Date.UTC(2026, 8, 11)); // September 2026
    assert.equal(getPartitionNameForDate(d1), 'transactions_y2026m09');

    const d2 = new Date(Date.UTC(2026, 0, 15)); // January 2026
    assert.equal(getPartitionNameForDate(d2), 'transactions_y2026m01');

    const d3 = new Date(Date.UTC(2026, 11, 31)); // December 2026
    assert.equal(getPartitionNameForDate(d3), 'transactions_y2026m12');
  });

  it('should calculate accurate partition start and end ranges', () => {
    const testDate = new Date(Date.UTC(2026, 2, 14, 15, 30)); // March 2026
    const range = getPartitionRange(testDate);

    assert.equal(range.name, 'transactions_y2026m03');
    assert.equal(range.start.toISOString(), '2026-03-01T00:00:00.000Z');
    assert.equal(range.end.toISOString(), '2026-04-01T00:00:00.000Z');
  });

  it('should handle year rollover accurately for December', () => {
    const decDate = new Date(Date.UTC(2026, 11, 25)); // Dec 2026
    const range = getPartitionRange(decDate);

    assert.equal(range.name, 'transactions_y2026m12');
    assert.equal(range.start.toISOString(), '2026-12-01T00:00:00.000Z');
    assert.equal(range.end.toISOString(), '2027-01-01T00:00:00.000Z');
  });

  it('should execute ensure_transactions_partition via database pool', async () => {
    const executedQueries: Array<{ text: string; values?: any[] }> = [];

    setMockPool({
      query: async (text: string, values?: any[]) => {
        executedQueries.push({ text, values });
        return { rows: [] };
      },
    });

    const targetDate = new Date(Date.UTC(2026, 9, 1));
    const partName = await ensurePartitionForDate(targetDate);

    assert.equal(partName, 'transactions_y2026m10');
    assert.equal(executedQueries.length, 1);
    assert.match(executedQueries[0].text, /ensure_transactions_partition/);
    assert.equal(executedQueries[0].values?.[0], '2026-10-01T00:00:00.000Z');

    setMockPool(null);
  });

  it('should fall back to DDL creation if ensure_transactions_partition function is missing', async () => {
    const executedQueries: Array<{ text: string; values?: any[] }> = [];

    setMockPool({
      query: async (text: string, values?: any[]) => {
        if (text.includes('ensure_transactions_partition')) {
          const err: any = new Error('function ensure_transactions_partition(timestamp with time zone) does not exist');
          err.code = '42883';
          throw err;
        }
        executedQueries.push({ text, values });
        return { rows: [] };
      },
    });

    const targetDate = new Date(Date.UTC(2026, 10, 1));
    const partName = await ensurePartitionForDate(targetDate);

    assert.equal(partName, 'transactions_y2026m11');
    assert.equal(executedQueries.length, 1);
    assert.match(executedQueries[0].text, /CREATE TABLE IF NOT EXISTS "transactions_y2026m11"/);

    setMockPool(null);
  });

  it('should return empty list if DATABASE_URL is not configured', async () => {
    const origUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    const parts = await ensurePartitionsAhead(3);
    assert.deepEqual(parts, []);

    if (origUrl) process.env.DATABASE_URL = origUrl;
  });

  it('should manage scheduler start and stop cleanly', () => {
    const timer = startPartitionMaintenanceScheduler(60000);
    assert.ok(timer);

    stopPartitionMaintenanceScheduler();
  });
});

describe('Partition retention', () => {
  const now = new Date(Date.UTC(2026, 10, 12)); // 2026-11-12
  const names = ['transactions_y2025m09', 'transactions_y2025m10', 'transactions_y2025m11', 'transactions_y2026m10', 'transactions_default', 'transactions_y2026m11'];

  it('keeps everything when retention is unset or below 1', () => {
    assert.deepEqual(selectExpiredPartitions(names, 0, now), []);
    assert.deepEqual(selectExpiredPartitions(names, NaN, now), []);
  });

  it('expires only months that ended before the cutoff and never the default partition', () => {
    // 12 months retention at 2026-11-12: cutoff 2025-11-01. Oct 2025 ends 2025-11-01 -> expired; Nov 2025 is kept.
    assert.deepEqual(selectExpiredPartitions(names, 12, now), ['transactions_y2025m09', 'transactions_y2025m10']);
  });

  it('detaches then drops each expired partition, and does nothing without DATABASE_URL', async () => {
    const executed: string[] = [];
    setMockPool({
      query: async (text: string) => {
        executed.push(text);
        if (text.includes('pg_inherits')) return { rows: names.map((name) => ({ name })) };
        return { rows: [] };
      },
    });
    const orig = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    assert.deepEqual(await dropExpiredPartitions(12, now), []);
    process.env.DATABASE_URL = 'postgres://test';
    const dropped = await dropExpiredPartitions(12, now);
    assert.deepEqual(dropped, ['transactions_y2025m09', 'transactions_y2025m10']);
    assert.ok(executed.some((q) => q === 'ALTER TABLE transactions DETACH PARTITION "transactions_y2025m09"'));
    assert.ok(executed.some((q) => q === 'DROP TABLE "transactions_y2025m10"'));
    if (orig) process.env.DATABASE_URL = orig; else delete process.env.DATABASE_URL;
    setMockPool(null);
  });
});
