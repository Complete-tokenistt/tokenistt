/**
 * The local SQLite database (.tokenistt/database/local.db), via Node's built-in node:sqlite so there is no
 * native dependency to compile. Schema changes are numbered entries in MIGRATIONS, applied once in order
 * and recorded in PRAGMA user_version.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CliError } from '../core/errors.js';
import { projectDir } from './project.js';

export type Database = DatabaseSync;

export const MIGRATIONS: string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** node:sqlite warns that it is experimental on every load; that is noise for CLI users, other warnings still print. */
function loadSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('SQLite')) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const mod = process.getBuiltinModule('node:sqlite');
    if (!mod) throw new Error('node:sqlite is unavailable');
    return mod;
  } catch {
    throw new CliError(`This Node.js (${process.version}) has no built-in SQLite.`, 1, 'Install Node.js 22.13 or newer.');
  } finally {
    process.emitWarning = original;
  }
}

export function migrate(db: Database, migrations: string[] = MIGRATIONS): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;
  if (current > migrations.length) {
    throw new CliError(`The local database is at schema ${current}, newer than this CLI understands (${migrations.length}).`, 1, 'Upgrade tokenistt, or delete .tokenistt/database to rebuild it.');
  }
  for (let v = current; v < migrations.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migrations[v] ?? '');
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new CliError(`Local database migration ${v + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return migrations.length;
}

export const databasePath = (root: string): string => join(projectDir(root), 'database', 'local.db');

export function openDatabase(root: string): Database {
  const file = databasePath(root);
  mkdirSync(dirname(file), { recursive: true });
  const { DatabaseSync: Sqlite } = loadSqlite();
  const db = new Sqlite(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}
