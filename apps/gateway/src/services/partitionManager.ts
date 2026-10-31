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
  ensurePartitionsAhead(3).catch((err) => {
    console.warn('[PartitionManager] Initial partition maintenance failed:', err.message);
  });

  maintenanceTimer = setInterval(() => {
    ensurePartitionsAhead(3).catch((err) => {
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

