/**
 * Moves hook events from their append-only files into SQLite, where they can be queried. Reading only past the last
 * ingested byte makes this cheap to call often; the primary key makes a repeated event harmless.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../store/db.js';
import { projectDir } from '../store/project.js';
import type { AgentEvent } from './schemas.js';

export const sessionKey = (agent: string, session: string): string => `${agent}:${session}`;

export interface IngestResult {
  files: number;
  events: number;
}

function readFrom(file: string, offset: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return Buffer.alloc(0);
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** The files are plain text on disk, so a line that parses is not necessarily an event. */
function isEvent(v: unknown): v is AgentEvent {
  const e = v as Partial<AgentEvent> | null;
  return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.agent === 'string' && typeof e.session === 'string' && typeof e.type === 'string' && typeof e.at === 'string';
}

function applyEvent(db: Database, e: AgentEvent): boolean {
  const key = sessionKey(e.agent, e.session);
  const inserted = db.prepare(`INSERT OR IGNORE INTO agent_events (id, session_key, type, at, tool, path, command, ok, reason, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.id, key, e.type, e.at, e.tool ?? null, e.path ?? null, e.command ?? null, e.ok === undefined ? null : e.ok ? 1 : 0, e.reason ?? null, e.model ?? null);
  if (inserted.changes === 0) return false;
  db.prepare(`INSERT INTO agent_sessions (key, agent, session_id, branch, started_at, last_event_at, status, model, task, transcript, proxy_host)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET
      last_event_at = max(last_event_at, excluded.last_event_at),
      started_at = min(started_at, excluded.started_at),
      branch = coalesce(excluded.branch, branch),
      model = coalesce(excluded.model, model),
      task = coalesce(excluded.task, task),
      transcript = coalesce(excluded.transcript, transcript),
      proxy_host = coalesce(excluded.proxy_host, proxy_host)`).run(key, e.agent, e.session, e.branch ?? null, e.at, e.at, e.model ?? null, e.task ?? null, e.transcript ?? null, e.proxyHost ?? null);
  if (e.type === 'SESSION_ENDED') {
    db.prepare(`UPDATE agent_sessions SET status = 'ended', ended_at = ?, end_reason = ? WHERE key = ?`).run(e.at, e.reason ?? null, key);
  } else if (e.type === 'SESSION_STARTED' || e.type === 'SESSION_RESUMED' || e.type === 'TASK_STARTED') {
    db.prepare(`UPDATE agent_sessions SET status = 'active', ended_at = NULL WHERE key = ?`).run(key);
  }
  return true;
}

export function ingestEvents(root: string, db: Database): IngestResult {
  const dir = join(projectDir(root), 'sessions');
  const result: IngestResult = { files: 0, events: 0 };
  if (!existsSync(dir)) return result;
  const getOffset = db.prepare('SELECT offset FROM agent_ingest WHERE file = ?');
  const setOffset = db.prepare('INSERT INTO agent_ingest (file, offset) VALUES (?, ?) ON CONFLICT (file) DO UPDATE SET offset = excluded.offset');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const offset = (getOffset.get(name) as { offset: number } | undefined)?.offset ?? 0;
    const buf = readFrom(join(dir, name), offset);
    // A line still being written has no newline yet; it is picked up next time.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) continue;
    result.files++;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // One corrupt line must not block the rest.
        }
        if (isEvent(parsed) && applyEvent(db, parsed)) result.events++;
      }
      setOffset.run(name, offset + end + 1);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return result;
}
