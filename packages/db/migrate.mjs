#!/usr/bin/env node
// Applies drizzle/NNNN_*.sql in order, then views.sql (idempotent, re-run every time).
// Applied files are tracked in schema_migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'drizzle');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
});
await client.connect();
await client.query(
  'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
);
const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
const files = readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();

for (const f of [...files, 'views.sql']) {
  const tracked = f !== 'views.sql';
  if (tracked && done.has(f)) continue;
  console.log(`apply ${f}`);
  await client.query(readFileSync(join(dir, f), 'utf8'));
  if (tracked) await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
}
await client.end();
console.log('migrations up to date');
