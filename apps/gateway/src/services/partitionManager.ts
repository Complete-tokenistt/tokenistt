/**
 * services/partitionManager.ts — Automated Monthly Partition Maintenance
 *
 * Ensures rolling monthly partitions for the `transactions` table
 * (e.g. current month + next 3 months) exist in PostgreSQL.
 *
 * Prevents transaction ingestion from ever hitting the unpartitioned fallback
 * or failing during month roll-overs.
 */

import { getPool } from '../db/pool.js';

let maintenanceTimer: NodeJS.Timeout | null = null;

/**
 * Returns partition name for a given date in format: transactions_yYYYYmMM
 */
export function getPartitionNameForDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `transactions_y${yyyy}m${mm}`;
}

/**
 * Returns UTC boundaries [start, end) for the monthly partition containing `date`.
 */
export function getPartitionRange(date: Date): { start: Date; end: Date; name: string } {
  const yyyy = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = new Date(Date.UTC(yyyy, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(month === 11 ? yyyy + 1 : yyyy, (month + 1) % 12, 1, 0, 0, 0, 0));
  const name = getPartitionNameForDate(start);
  return { start, end, name };
}

/**
 * Ensures that a specific monthly partition exists in Postgres.
 * Attempts calling the built-in function `ensure_transactions_partition(for_date)`
 * and falls back to dynamic DDL if the procedure is not present.
 */
export async function ensurePartitionForDate(date: Date): Promise<string> {
  const pool = getPool();
  const { start, end, name } = getPartitionRange(date);

  try {
    // 1. Try invoking ensure_transactions_partition if defined in schema (0000_init.sql)
    await pool.query('SELECT ensure_transactions_partition($1::timestamptz)', [start.toISOString()]);
    return name;
  } catch (err: any) {
    // 2. If function does not exist (undefined_function 42883), execute direct DDL fallback
    if (err.code === '42883' || err.message?.includes('ensure_transactions_partition')) {
      const ddl = `
        CREATE TABLE IF NOT EXISTS "${name}"
        PARTITION OF transactions
        FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}');
      `;
      await pool.query(ddl);
      return name;
    }
    throw err;
  }
}

/**
 * Ensures monthly partitions exist for the current month and `monthsAhead` future months.
 * Defaults to 3 months ahead.
 */
export async function ensurePartitionsAhead(monthsAhead: number = 3): Promise<string[]> {
  if (!process.env.DATABASE_URL) {
    return [];
  }

  const ensuredNames: string[] = [];
  const now = new Date();

  for (let i = 0; i <= monthsAhead; i++) {
    const targetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    try {
      const partName = await ensurePartitionForDate(targetDate);
      ensuredNames.push(partName);
    } catch (err: any) {
      console.warn(`[PartitionManager] Failed ensuring partition for ${targetDate.toISOString().slice(0, 7)}:`, err.message);
    }
  }

  if (ensuredNames.length > 0) {
    console.log(`[PartitionManager] ✓ Ensured ${ensuredNames.length} monthly partitions ahead: ${ensuredNames.join(', ')}`);
  }

  return ensuredNames;
}

const PARTITION_NAME_RE = /^transactions_y(\d{4})m(\d{2})$/;

/**
 * Pure helper: which of `names` are monthly partitions that ended on or before the retention cutoff.
 * A partition covering month M is expired once M + 1 <= (current month - retentionMonths), i.e. every
 * row in it is older than `retentionMonths` full months. Non-matching names (default partition etc.)
 * are never returned.
 */
export function selectExpiredPartitions(names: string[], retentionMonths: number, now: Date = new Date()): string[] {
  if (!Number.isFinite(retentionMonths) || retentionMonths < 1) return [];
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - Math.floor(retentionMonths), 1);
  return names.filter((name) => {
    const m = PARTITION_NAME_RE.exec(name);
    if (!m) return false;
    const partitionEnd = Date.UTC(Number(m[1]), Number(m[2]), 1); // first day of the following month
    return partitionEnd <= cutoff;
  });
}

/**
 * Drops monthly `transactions` partitions older than `retentionMonths`. OFF by default: the request
 * log is the record of spend, so deleting it is an explicit operator decision
 * (TRANSACTIONS_RETENTION_MONTHS). Rollups (`hourly_spend`) are not touched.
 */
export async function dropExpiredPartitions(retentionMonths: number, now: Date = new Date()): Promise<string[]> {
  if (!process.env.DATABASE_URL || !(retentionMonths >= 1)) return [];
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.relname AS name
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'transactions'`
  );
  const expired = selectExpiredPartitions(rows.map((r: { name: string }) => r.name), retentionMonths, now);
  const dropped: string[] = [];
  for (const name of expired) {
    try {
      // name is validated against PARTITION_NAME_RE above, so quoting it is safe.
      await pool.query(`ALTER TABLE transactions DETACH PARTITION "${name}"`);
      await pool.query(`DROP TABLE "${name}"`);
      dropped.push(name);
    } catch (err: any) {
      console.warn(`[PartitionManager] Failed dropping expired partition ${name}:`, err.message);
    }
  }
  if (dropped.length > 0) {
    console.log(`[PartitionManager] Dropped ${dropped.length} partition(s) older than ${retentionMonths} month(s): ${dropped.join(', ')}`);
  }
  return dropped;
}

async function runMaintenance(): Promise<void> {
  await ensurePartitionsAhead(3);
  const retention = Number(process.env.TRANSACTIONS_RETENTION_MONTHS);
  if (retention >= 1) await dropExpiredPartitions(retention);
}

/**
 * Starts a periodic background scheduler to maintain future partitions.
 * Defaults to running once every 24 hours.
 */
export function startPartitionMaintenanceScheduler(
  intervalMs: number = 24 * 60 * 60 * 1000
): NodeJS.Timeout | null {
  if (maintenanceTimer) {
    return maintenanceTimer;
  }

  // Run initial check asynchronously
  runMaintenance().catch((err) => {
    console.warn('[PartitionManager] Initial partition maintenance failed:', err.message);
  });

  maintenanceTimer = setInterval(() => {
    runMaintenance().catch((err) => {
      console.warn('[PartitionManager] Scheduled partition maintenance failed:', err.message);
    });
  }, intervalMs);

  // Prevent this timer from keeping the process alive if everything else exits
  if (maintenanceTimer && typeof maintenanceTimer.unref === 'function') {
    maintenanceTimer.unref();
  }

  return maintenanceTimer;
}

/**
 * Stops the periodic background scheduler if running.
 */
export function stopPartitionMaintenanceScheduler(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    console.log('[PartitionManager] Partition maintenance scheduler stopped.');
  }
}

