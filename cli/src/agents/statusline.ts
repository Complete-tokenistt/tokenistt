/**
 * `tokenistt statusline`: one short line about the current agent session, for an agent's own status bar.
 * Claude Code runs the configured command and shows its stdout, passing session details as JSON on stdin. It is called
 * often, so this stays on a fast path (see bin/tokenistt.js) and, like a hook, never fails: whatever goes wrong it
 * prints a plain "tokenistt" and exits 0.
 */
import { findProjectRoot } from './hook-main.js';
import { listSessions, readPrices, refresh, summarize, type SessionSummary } from './sessions.js';
import { openDatabase } from '../store/db.js';

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** A short cost that never pretends: "~$0.42", "~$0.42+" when part is unpriced, "cost n/a" when nothing is. */
export function compactCost(c: SessionSummary['cost']): string {
  if (c.costUsd !== null) return `~$${c.costUsd.toFixed(2)}`;
  if ((c.knownUsd ?? 0) > 0) return `~$${(c.knownUsd ?? 0).toFixed(2)}+`;
  return 'cost n/a';
}

/** Pure, so the wording is tested without a database. */
export function formatStatusLine(s: SessionSummary | undefined): string {
  if (!s) return 'tokenistt · waiting for the first event';
  const c = s.counts;
  const changed = c.filesCreated + c.filesModified + c.filesDeleted;
  const parts = ['tokenistt', s.tokens ? `${compactTokens(s.tokens.total)} tok` : 'tokens n/a', compactCost(s.cost), `${c.tools + c.commands} tools`, `${changed} changed`];
  if (c.errors > 0) parts.push(`${c.errors} errors`);
  return parts.join(' · ');
}

export function statusLineFor(root: string, sessionId: string | undefined, now = Date.now()): string {
  const db = openDatabase(root);
  try {
    refresh(root, db);
    const rows = listSessions(db, { agent: 'claude-code', limit: 20 });
    const row = (sessionId ? rows.find((r) => r.session_id === sessionId) : undefined) ?? rows[0];
    return formatStatusLine(row ? summarize(db, row, now, readPrices(root)) : undefined);
  } finally {
    db.close();
  }
}

async function readInput(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += (c as Buffer).length;
    if (size > 1_000_000) return {};
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function runStatusLine(): Promise<void> {
  let line = 'tokenistt';
  try {
    const input = await readInput();
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const root = findProjectRoot(cwd);
    if (root) line = statusLineFor(root, typeof input.session_id === 'string' ? input.session_id : undefined);
  } catch {
    // keep the plain fallback
  }
  process.stdout.write(`${line}\n`);
  process.exitCode = 0;
}
