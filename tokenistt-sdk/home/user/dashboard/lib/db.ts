/**
 * lib/db.ts — Singleton pg.Pool for the Next.js dashboard (server-side only).
 *
 * Uses a module-level singleton so the pool is reused across hot-reloads in
 * dev mode and across concurrent route invocations in production.
 *
 * Set DATABASE_URL in dashboard/.env.local to enable real data.
 * Without it every route falls back to mock data automatically.
 */

import pg from 'pg';

const { Pool } = pg;

// Extend global to persist pool across Next.js hot-reloads in dev
declare global {
  // eslint-disable-next-line no-var
  var __pgPool: pg.Pool | undefined;
}

function createPool(): pg.Pool {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX ?? '5', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl:
      process.env.DATABASE_SSL === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
  });

  pool.on('error', (err) => {
    console.error('[Dashboard DB] Idle client error:', err.message);
  });

  return pool;
}

export function getPool(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }

  // Reuse pool across hot-reloads in development
  if (process.env.NODE_ENV !== 'production') {
    if (!global.__pgPool) {
      global.__pgPool = createPool();
    }
    return global.__pgPool;
  }

  if (!global.__pgPool) {
    global.__pgPool = createPool();
  }
  return global.__pgPool;
}

/** Returns true if DATABASE_URL is configured and reachable. */
export async function isDbAvailable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const pool = getPool();
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch {
    return false;
  }
}
