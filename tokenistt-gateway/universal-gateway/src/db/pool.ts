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

const { Pool } = pg;

let _pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
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
    return true;
  } catch (err: any) {
    console.error('[DB Pool] Postgres connection failed:', err.message);
    return false;
  }
}
