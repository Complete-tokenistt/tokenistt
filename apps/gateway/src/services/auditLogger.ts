/**
 * services/auditLogger.ts — immutable audit trail for policy / budget / routing
 * decisions (policy_audit_log) and admin actions (audit_log).
 *
 * Writes are fire-and-forget: they never block or fail a request. If the DB write
 * fails, the entry is appended to a JSONL file and replayed by drainAuditQueue().
 * Both tables are append-only (DB trigger blocks UPDATE/DELETE).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPool } from '../db/pool.js';

export type DecisionKind = 'policy' | 'budget' | 'routing';

export interface DecisionEntry {
  organizationId?: bigint | string | null;
  kind: DecisionKind;
  subjectId?: string | null;
  requestId?: string | null;
  decision: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AdminActionEntry {
  organizationId?: bigint | string | null;
  actor: string;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

type QueueItem =
  | { table: 'policy_audit_log'; entry: DecisionEntry; queuedAt: string; attempts: number }
  | { table: 'audit_log'; entry: AdminActionEntry; queuedAt: string; attempts: number };

const MAX_ATTEMPTS = 10;
const queueFile = () => process.env.AUDIT_QUEUE_FILE || join(process.cwd(), 'audit_queue.jsonl');

const orgParam = (v: bigint | string | null | undefined): string | null =>
  v === undefined || v === null ? null : v.toString();

/** Strip secrets before anything is persisted. */
function redact(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = /key|secret|token|password|authorization/i.test(k) ? '[REDACTED]' : redact(v);
  }
  return out;
}

async function insert(item: QueueItem): Promise<void> {
  const pool = getPool();
  if (item.table === 'policy_audit_log') {
    const e = item.entry;
    await pool.query(
      `INSERT INTO policy_audit_log (organization_id, kind, subject_id, request_id, decision, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orgParam(e.organizationId), e.kind, e.subjectId ?? null, e.requestId ?? null,
       e.decision, e.reason ?? null, JSON.stringify(redact(e.metadata ?? {}))]
    );
  } else {
    const e = item.entry;
    await pool.query(
      `INSERT INTO audit_log (organization_id, actor, action, entity_type, entity_id, before, after, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [orgParam(e.organizationId), e.actor, e.action, e.entityType ?? null, e.entityId ?? null,
       e.before === undefined ? null : JSON.stringify(redact(e.before)),
       e.after === undefined ? null : JSON.stringify(redact(e.after)),
       e.ip ?? null]
    );
  }
}

function enqueue(item: QueueItem): void {
  try {
    appendFileSync(queueFile(), JSON.stringify(item) + '\n', 'utf-8');
  } catch (err: any) {
    console.error('[Audit] Could not persist audit entry to fallback file:', err.message);
  }
}

function submit(item: QueueItem): void {
  if (!process.env.DATABASE_URL) return; // open mode: nothing to write to
  insert(item).catch(() => enqueue({ ...item, attempts: item.attempts + 1 }));
}

/** Record an automated decision. Never throws, never awaited on the request path. */
export function logDecision(entry: DecisionEntry): void {
  submit({ table: 'policy_audit_log', entry, queuedAt: new Date().toISOString(), attempts: 0 });
}

/** Record an admin/human action. Never throws. */
export function logAdminAction(entry: AdminActionEntry): void {
  submit({ table: 'audit_log', entry, queuedAt: new Date().toISOString(), attempts: 0 });
}

/** Replay queued entries after the DB recovers. Returns how many were written. */
export async function drainAuditQueue(): Promise<number> {
  const file = queueFile();
  if (!existsSync(file) || !process.env.DATABASE_URL) return 0;

  const lines = readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
  const remaining: string[] = [];
  let written = 0;

  for (const line of lines) {
    let item: QueueItem;
    try { item = JSON.parse(line); } catch { continue; } // drop corrupt line
    try {
      await insert(item);
      written++;
    } catch {
      if (item.attempts + 1 < MAX_ATTEMPTS) {
        remaining.push(JSON.stringify({ ...item, attempts: item.attempts + 1 }));
      } else {
        console.error('[Audit] Dropping audit entry after max attempts:', item.table);
      }
    }
  }
  writeFileSync(file, remaining.length ? remaining.join('\n') + '\n' : '', 'utf-8');
  return written;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startAuditDrainScheduler(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => { drainAuditQueue().catch(() => {}); }, intervalMs);
  timer.unref?.();
}
export function stopAuditDrainScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
