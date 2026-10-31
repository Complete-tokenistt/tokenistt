/**
 * db/pool.ts — Postgres connection pool (singleton).
 *
 * Uses `pg.Pool` for high-traffic connection reuse.
 * The pool is lazy — it only connects when first used.
 * Call `closePool()` on graceful shutdown.
 *
 * Required env var:  DATABASE_URL=postgres://user:pass@host:5432/dbname
 * Optional:          DB_POOL_MAX (default 10)
 */
import pg from 'pg';
import { migratePolicies } from './policies.js';

const { Pool } = pg;

let _pool: pg.Pool | null = null;
let mockPool: any = null;

export function setMockPool(pool: any) {
  mockPool = pool;
}

export function getPool(): pg.Pool {
  if (mockPool) {
    return mockPool;
  }
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. ' +
        'Set it to postgres://user:pass@host:5432/dbname to enable ' +
        'virtual-key auth and transaction logging.'
      );
    }

    _pool = new Pool({
      connectionString,
      max: parseInt(process.env.DB_POOL_MAX ?? '10', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.DATABASE_SSL === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
    });

    _pool.on('error', (err) => {
      console.error('[DB Pool] Unexpected error on idle client:', err.message);
    });

    installConnectRetry(_pool);
    console.log('[DB Pool] Postgres pool initialised (max:', _pool.options.max, ')');
  }

  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    console.log('[DB Pool] Postgres pool closed.');
  }
}

/** Quick connectivity check — call at startup. */
export async function checkDbConnection(): Promise<boolean> {
  try {
    const pool = getPool();
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('[DB Pool] Postgres connection OK.');
    await migratePolicies();
    return true;
  } catch (err: any) {
    console.error('[DB Pool] Postgres connection failed:', err.message);
    return false;
  }
}

/**
 * Connection-level errors where the statement was provably never sent, so a retry
 * cannot duplicate a write. (Serverless poolers such as Neon drop idle connections;
 * pg evicts the dead client and the next attempt gets a fresh one.)
 */
const CONNECT_ERRORS = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timeout exceeded when trying to connect|Connection terminated due to connection timeout/i;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function installConnectRetry(pool: pg.Pool): void {
  const attempts = parseInt(process.env.DB_CONNECT_RETRIES ?? '2', 10);
  const original = pool.query.bind(pool) as (...a: any[]) => Promise<any>;
  (pool as any).query = async (...args: any[]) => {
    // Only the promise form is wrapped; callback-style callers keep pg's behaviour.
    if (typeof args[args.length - 1] === 'function') return original(...args);
    for (let i = 0; ; i++) {
      try {
        return await original(...args);
      } catch (err: any) {
        const retriable = CONNECT_ERRORS.test(String(err?.message)) || CONNECT_ERRORS.test(String(err?.code));
        if (!retriable || i >= attempts) throw err;
        await sleep(100 * 2 ** i);
      }
    }
  };
}
