/**
 * Project memory. Every entry says where it came from, and history is never overwritten: changing a memory writes a
 * new row that supersedes the old one, which stays readable. Content is scrubbed of anything credential-shaped.
 */
import { randomBytes } from 'node:crypto';
import { CliError, UsageError } from '../core/errors.js';
import { redactText } from '../core/redact.js';
import type { Database } from '../store/db.js';

export const CATEGORIES = [
  'PROJECT_OVERVIEW', 'ARCHITECTURE', 'TECH_STACK', 'MODULE_CONTEXT', 'CODING_CONVENTIONS', 'ARCHITECTURAL_DECISIONS', 'IMPLEMENTATION_PROGRESS',
  'OPEN_TASKS', 'KNOWN_ISSUES', 'DEBUGGING_HISTORY', 'FAILED_APPROACHES', 'IMPORTANT_DEPENDENCIES', 'AGENT_SESSION_SUMMARIES', 'RECENT_CHANGES',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type MemoryStatus = 'active' | 'superseded' | 'stale' | 'retired';
/** Where a memory came from: what `source_ref` points at. */
export type SourceKind = 'session' | 'commit' | 'file' | 'graph' | 'detection' | 'user' | 'agent';

export interface Memory {
  id: string;
  project_id: string;
  category: Category;
  content: string;
  source_kind: SourceKind;
  source_ref: string;
  /** How sure the extraction is, 0 to 1. A user or a decision record is 1; a pattern read from events is lower. */
  confidence: number;
  /** How much this tends to matter when choosing what to show, 0 to 1. */
  relevance: number;
  status: MemoryStatus;
  /** Identifies the fact this is about, so a new version replaces rather than duplicates it. */
  dedupe_key: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  stale_reason: string | null;
  created_at: string;
  updated_at: string;
  /** After this date it is treated as stale unless renewed. */
  review_at: string | null;
}

export interface NewMemory {
  category: Category;
  content: string;
  sourceKind: SourceKind;
  sourceRef: string;
  confidence?: number;
  relevance?: number;
  dedupeKey?: string;
  nodes?: string[];
  sessions?: string[];
  reviewAt?: string;
  now?: Date;
}

export const newMemoryId = (): string => `mem_${randomBytes(8).toString('hex')}`;

export function isCategory(v: string): v is Category {
  return (CATEGORIES as readonly string[]).includes(v);
}

export function parseCategory(v: string): Category {
  const up = v.toUpperCase().replace(/-/g, '_');
  if (!isCategory(up)) throw new UsageError(`Unknown category "${v}".`, `Use one of: ${CATEGORIES.join(', ')}.`);
  return up;
}

function insertLinks(db: Database, id: string, nodes: string[] = [], sessions: string[] = []): void {
  const n = db.prepare('INSERT OR IGNORE INTO memory_nodes (memory_id, node_id) VALUES (?, ?)');
  for (const node of nodes) n.run(id, node);
  const s = db.prepare('INSERT OR IGNORE INTO memory_sessions (memory_id, session_key) VALUES (?, ?)');
  for (const session of sessions) s.run(id, session);
}

function indexFts(db: Database, id: string, category: string, content: string): void {
  db.prepare('INSERT INTO memory_fts (id, category, content) VALUES (?, ?, ?)').run(id, category, content);
}

/**
 * Adds a memory, or a new version of the fact named by `dedupeKey`. Identical content changes nothing, so extraction
 * can run as often as it likes. Different content keeps the old row, marked superseded.
 */
export function remember(db: Database, projectId: string, m: NewMemory): { id: string; outcome: 'created' | 'updated' | 'unchanged' } {
  const content = redactText(m.content).trim();
  if (!content) throw new UsageError('A memory needs some content.');
  const now = (m.now ?? new Date()).toISOString();
  const existing = m.dedupeKey
    ? db.prepare(`SELECT * FROM memories WHERE dedupe_key = ? AND status IN ('active', 'stale') ORDER BY created_at DESC LIMIT 1`).get(m.dedupeKey) as Memory | undefined
    : undefined;
  if (existing && existing.content === content) {
    // Still true, so it is no longer stale, and its review date moves on.
    db.prepare(`UPDATE memories SET status = 'active', stale_reason = NULL, updated_at = ?, review_at = ? WHERE id = ?`).run(now, m.reviewAt ?? existing.review_at, existing.id);
    insertLinks(db, existing.id, m.nodes, m.sessions);
    return { id: existing.id, outcome: 'unchanged' };
  }
  const id = newMemoryId();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO memories (id, project_id, category, content, source_kind, source_ref, confidence, relevance, status, dedupe_key, supersedes, created_at, updated_at, review_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`).run(id, projectId, m.category, content, m.sourceKind, m.sourceRef, m.confidence ?? 0.7, m.relevance ?? 0.5, m.dedupeKey ?? null, existing?.id ?? null, now, now, m.reviewAt ?? null);
    if (existing) {
      db.prepare(`UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`).run(id, now, existing.id);
      db.prepare('DELETE FROM memory_fts WHERE id = ?').run(existing.id);
    }
    insertLinks(db, id, m.nodes, m.sessions);
    indexFts(db, id, m.category, content);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { id, outcome: existing ? 'updated' : 'created' };
}

export function getMemory(db: Database, id: string): Memory {
  const rows = db.prepare(`SELECT * FROM memories WHERE id LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 2`).all(`${id.replace(/[\\%_]/g, '\\$&')}%`) as unknown as Memory[];
  if (rows.length === 0) throw new CliError(`No memory matches "${id}".`, 2, 'List them with `tokenistt memory show`.');
  if (rows.length > 1) throw new CliError(`"${id}" matches more than one memory.`, 2, 'Use more of the id.');
  return rows[0] as Memory;
}

/** A manual change. It replaces the entry as a new version, so what it used to say is still there. */
export function editMemory(db: Database, id: string, content: string, now = new Date()): string {
  const old = getMemory(db, id);
  if (old.status === 'superseded') throw new CliError(`${old.id} has been replaced by ${old.superseded_by}.`, 2, 'Edit the current version.');
  const key = old.dedupe_key ?? `manual:${old.id}`;
  if (!old.dedupe_key) db.prepare('UPDATE memories SET dedupe_key = ? WHERE id = ?').run(key, old.id);
  const links = db.prepare('SELECT node_id FROM memory_nodes WHERE memory_id = ?').all(old.id) as Array<{ node_id: string }>;
  return remember(db, old.project_id, { category: old.category, content, sourceKind: 'user', sourceRef: `edit of ${old.id}`, confidence: 1, relevance: old.relevance, dedupeKey: key, nodes: links.map((l) => l.node_id), now }).id;
}

/** Stops showing a memory without erasing it. */
export function retireMemory(db: Database, id: string, reason: string, now = new Date()): Memory {
  const m = getMemory(db, id);
  db.prepare(`UPDATE memories SET status = 'retired', stale_reason = ?, updated_at = ? WHERE id = ?`).run(reason, now.toISOString(), m.id);
  db.prepare('DELETE FROM memory_fts WHERE id = ?').run(m.id);
  return { ...m, status: 'retired', stale_reason: reason };
}

export function markStale(db: Database, id: string, reason: string, now: Date): void {
  db.prepare(`UPDATE memories SET status = 'stale', stale_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'`).run(reason, now.toISOString(), id);
}

/** Every version of a fact, oldest first. */
export function memoryHistory(db: Database, id: string): Memory[] {
  let at: Memory | undefined = getMemory(db, id);
  const chain: Memory[] = [];
  const seen = new Set<string>();
  while (at && !seen.has(at.id)) {
    chain.unshift(at);
    seen.add(at.id);
    at = at.supersedes ? db.prepare('SELECT * FROM memories WHERE id = ?').get(at.supersedes) as Memory | undefined : undefined;
  }
  let forward = chain[chain.length - 1]?.superseded_by;
  while (forward && !seen.has(forward)) {
    const next = db.prepare('SELECT * FROM memories WHERE id = ?').get(forward) as Memory | undefined;
    if (!next) break;
    chain.push(next);
    seen.add(next.id);
    forward = next.superseded_by;
  }
  return chain;
}

export function listMemories(db: Database, opts: { category?: Category; includeInactive?: boolean; limit?: number } = {}): Memory[] {
  const statuses = opts.includeInactive ? `('active', 'stale', 'superseded', 'retired')` : `('active', 'stale')`;
  const limit = opts.limit ?? 200;
  if (opts.category) return db.prepare(`SELECT * FROM memories WHERE status IN ${statuses} AND category = ? ORDER BY relevance DESC, updated_at DESC LIMIT ?`).all(opts.category, limit) as unknown as Memory[];
  return db.prepare(`SELECT * FROM memories WHERE status IN ${statuses} ORDER BY relevance DESC, updated_at DESC LIMIT ?`).all(limit) as unknown as Memory[];
}

/** Turns free text into an FTS query of quoted prefix terms, so punctuation from a user can't be read as FTS syntax. */
export function ftsQuery(text: string): string {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

export function searchMemories(db: Database, text: string, limit = 20): Array<Memory & { score: number }> {
  const q = ftsQuery(text);
  if (!q) return [];
  const rows = db.prepare(`SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts JOIN memories m ON m.id = memory_fts.id
    WHERE memory_fts MATCH ? AND m.status IN ('active', 'stale') ORDER BY rank LIMIT ?`).all(q, limit * 3) as unknown as Array<Memory & { rank: number }>;
  // bm25 is lower-is-better. Relevance and being current then shift the order among comparable matches.
  return rows.map(({ rank, ...m }) => ({ ...(m as Memory), score: -rank * (0.5 + m.relevance) * (m.status === 'stale' ? 0.5 : 1) }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

export function linkedNodes(db: Database, id: string): string[] {
  return (db.prepare('SELECT node_id FROM memory_nodes WHERE memory_id = ? ORDER BY node_id').all(id) as Array<{ node_id: string }>).map((r) => r.node_id);
}

export function linkedSessions(db: Database, id: string): string[] {
  return (db.prepare('SELECT session_key FROM memory_sessions WHERE memory_id = ? ORDER BY session_key').all(id) as Array<{ session_key: string }>).map((r) => r.session_key);
}

export function memoriesForNodes(db: Database, nodes: string[], limit = 20): Memory[] {
  if (nodes.length === 0) return [];
  const out = new Map<string, Memory>();
  const stmt = db.prepare(`SELECT m.* FROM memory_nodes n JOIN memories m ON m.id = n.memory_id WHERE n.node_id = ? AND m.status IN ('active', 'stale') ORDER BY m.relevance DESC LIMIT ?`);
  for (const node of nodes) {
    for (const m of stmt.all(node, limit) as unknown as Memory[]) out.set(m.id, m);
    if (out.size >= limit) break;
  }
  return [...out.values()].slice(0, limit);
}

export interface MemoryStats {
  total: number;
  active: number;
  stale: number;
  superseded: number;
  retired: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  lastUpdated: string | null;
}

export function memoryStats(db: Database): MemoryStats {
  const status = Object.fromEntries((db.prepare('SELECT status, count(*) AS c FROM memories GROUP BY status').all() as Array<{ status: string; c: number }>).map((r) => [r.status, r.c]));
  const grouped = (col: string) => Object.fromEntries((db.prepare(`SELECT ${col} AS k, count(*) AS c FROM memories WHERE status IN ('active', 'stale') GROUP BY ${col} ORDER BY ${col}`).all() as Array<{ k: string; c: number }>).map((r) => [r.k, r.c]));
  const last = db.prepare(`SELECT max(updated_at) AS at FROM memories`).get() as { at: string | null };
  return {
    total: Object.values(status).reduce((a, b) => a + b, 0), active: status.active ?? 0, stale: status.stale ?? 0, superseded: status.superseded ?? 0, retired: status.retired ?? 0,
    byCategory: grouped('category'), bySource: grouped('source_kind'), lastUpdated: last.at,
  };
}
