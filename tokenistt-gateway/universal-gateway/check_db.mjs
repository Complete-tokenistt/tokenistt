import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env')) config();
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 8000,
  ssl: { rejectUnauthorized: false }
});

try {
  const r = await pool.query(`SELECT version(), current_database(), now()`);
  console.log('✓ DB connected:', r.rows[0].version.split(' ').slice(0,2).join(' '));
  console.log('  Database:', r.rows[0].current_database);

  const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  console.log('  Tables:', tables.rows.map(r=>r.tablename).join(', '));

  const orgs = await pool.query(`SELECT id, name, plan FROM organizations`);
  console.log('  Orgs:', orgs.rows.map(r=>`${r.id}:${r.name}`).join(', '));

  const vkeys = await pool.query(`SELECT COUNT(*) c FROM virtual_keys WHERE status='active'`);
  console.log('  Active virtual keys:', vkeys.rows[0].c);

  const txns = await pool.query(`SELECT COUNT(*) c, COALESCE(SUM(cost_usd),0)::float t FROM transactions WHERE status='success'`);
  console.log(`  Transactions: ${txns.rows[0].c} rows, $${parseFloat(txns.rows[0].t).toFixed(6)} total`);

  const models = await pool.query(`SELECT COUNT(*) c FROM model_catalog WHERE status='active'`);
  console.log('  Pricing catalog:', models.rows[0].c, 'active models');

  console.log('\n✓ DB check passed — gateway ready to start');
} catch(e) {
  console.error('✗ DB error:', e.message);
} finally {
  await pool.end();
}
