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
  `CREATE TABLE file_extracts (path TEXT PRIMARY KEY, sha TEXT NOT NULL, extractor INTEGER NOT NULL, extract TEXT NOT NULL) STRICT;
   CREATE TABLE graph_nodes (
     id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, path TEXT, language TEXT, parent TEXT,
     start_line INTEGER, end_line INTEGER, metadata TEXT
   ) STRICT;
   CREATE INDEX graph_nodes_type ON graph_nodes (type);
   CREATE INDEX graph_nodes_path ON graph_nodes (path);
   CREATE TABLE graph_edges (
     source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, confidence REAL NOT NULL, resolution TEXT NOT NULL, line INTEGER,
     PRIMARY KEY (source, target, type)
   ) STRICT, WITHOUT ROWID;
   CREATE INDEX graph_edges_target ON graph_edges (target, type);
   CREATE VIRTUAL TABLE graph_fts USING fts5(id UNINDEXED, name, path, tokenize = "unicode61 tokenchars '_'");`,
  `CREATE TABLE agent_sessions (
     key TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, branch TEXT, started_at TEXT NOT NULL, ended_at TEXT,
     last_event_at TEXT NOT NULL, status TEXT NOT NULL, end_reason TEXT, model TEXT, task TEXT, transcript TEXT
   ) STRICT;
   CREATE INDEX agent_sessions_recent ON agent_sessions (last_event_at DESC);
   CREATE TABLE agent_events (
     id TEXT PRIMARY KEY, session_key TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, tool TEXT, path TEXT, command TEXT, ok INTEGER, reason TEXT, model TEXT
   ) STRICT;
   CREATE INDEX agent_events_session ON agent_events (session_key, at);
   CREATE INDEX agent_events_path ON agent_events (path);
   CREATE TABLE agent_ingest (file TEXT PRIMARY KEY, offset INTEGER NOT NULL) STRICT;`,
  `CREATE TABLE agent_usage (
     session_key TEXT NOT NULL, request_id TEXT NOT NULL, model TEXT, at TEXT,
     input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
     PRIMARY KEY (session_key, request_id)
   ) STRICT, WITHOUT ROWID;`,
  `CREATE TABLE memories (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL,
     source_kind TEXT NOT NULL, source_ref TEXT NOT NULL, confidence REAL NOT NULL, relevance REAL NOT NULL, status TEXT NOT NULL,
     dedupe_key TEXT, supersedes TEXT, superseded_by TEXT, stale_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, review_at TEXT
   ) STRICT;
   CREATE INDEX memories_current ON memories (status, category);
   CREATE INDEX memories_dedupe ON memories (dedupe_key);
   CREATE TABLE memory_nodes (memory_id TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY (memory_id, node_id)) STRICT, WITHOUT ROWID;
   CREATE INDEX memory_nodes_node ON memory_nodes (node_id);
   CREATE TABLE memory_sessions (memory_id TEXT NOT NULL, session_key TEXT NOT NULL, PRIMARY KEY (memory_id, session_key)) STRICT, WITHOUT ROWID;
   CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED, category UNINDEXED, content);`,
  `CREATE TABLE embeddings (node_id TEXT NOT NULL, model TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (node_id, model)) STRICT, WITHOUT ROWID;`,
  `ALTER TABLE agent_sessions ADD COLUMN proxy_host TEXT;
   CREATE TABLE agent_ledger_sent (session_key TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY (session_key, request_id)) STRICT, WITHOUT ROWID;`,
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
