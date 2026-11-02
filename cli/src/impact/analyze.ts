/**
 * What a change could affect, from the graph. This is reachability, not proof: it says what is connected, and how sure
 * each link is, not that something will break. Git history and agent activity are correlation, and are labelled so.
 */
import { UsageError } from '../core/errors.js';
import { git } from '../project/git.js';
import { GraphIndex, type Relation } from '../graph/query.js';
import type { GraphNode } from '../graph/schema.js';
import { memoriesForNodes } from '../memory/store.js';
import type { Database } from '../store/db.js';

export interface ImpactEntry {
  id: string;
  name: string;
  type: string;
  path?: string;
  line?: number;
  depth: number;
  via: string;
  confidence: number;
}

export interface BreakingHint {
  symbol: string;
  type: string;
  line?: number;
  usedBy: number;
  usedByFiles: string[];
}

export interface ImpactReport {
  targets: Array<{ id: string; name: string; type: string; path?: string }>;
  direct: ImpactEntry[];
  indirect: ImpactEntry[];
  apis: ImpactEntry[];
  tables: Array<{ name: string; access: string; from: string }>;
  tests: Array<{ path: string; depth: number }>;
  modules: string[];
  decisions: Array<{ id: string; content: string; source: string; stale: boolean }>;
  breaking: BreakingHint[];
  untested: boolean;
  /** Set when the graph was built from older code than what is on disk. */
  graphNote?: string;
}

/** Accepts a repo-relative path or a node id, then a unique name. An ambiguous name is an error, not a guess. */
export function resolveTarget(index: GraphIndex, ref: string): string {
  if (index.nodes.has(ref)) return ref;
  const norm = ref.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  for (const candidate of [`file:${norm}`, `dir:${norm}`]) if (index.nodes.has(candidate)) return candidate;
  const exact = index.search(ref, 20).filter((v) => v.name.toLowerCase() === ref.toLowerCase() && v.type !== 'directory' && v.type !== 'file');
  if (exact.length === 1 && exact[0]) return exact[0].id;
  if (exact.length > 1) {
    throw new UsageError(`"${ref}" matches ${exact.length} symbols.`, `Name the file or use an id: ${exact.slice(0, 4).map((v) => v.id).join(', ')}.`);
  }
  throw new UsageError(`Nothing in the graph matches "${ref}".`, 'Check the path, or run `tokenistt map` if it is new.');
}

const moduleOf = (modules: GraphNode[], path: string | undefined): string | undefined => {
  if (!path) return undefined;
  let best: GraphNode | undefined;
  for (const m of modules) {
    const dir = m.path ?? '.';
    if ((dir === '.' || path === dir || path.startsWith(`${dir}/`)) && (!best || (best.path ?? '.').length < dir.length)) best = m;
  }
  return best?.name;
};

function everything(index: GraphIndex, id: string): string[] {
  const out = [id];
  const stack = [id];
  while (stack.length) {
    for (const c of index.childrenOf(stack.pop() as string, 100_000).items) {
      out.push(c.id);
      stack.push(c.id);
    }
  }
  return out;
}

export function analyzeImpact(index: GraphIndex, db: Database, targetIds: string[], opts: { maxDepth?: number; root?: string } = {}): ImpactReport {
  const maxDepth = opts.maxDepth ?? 4;
  const best = new Map<string, ImpactEntry>();
  const contents = new Set<string>();
  for (const t of targetIds) {
    for (const c of everything(index, t)) contents.add(c);
    for (const hit of index.traverse(t, 'dependents', { maxDepth, limit: 2000 })) {
      const n = index.nodes.get(hit.id);
      if (!n) continue;
      const known = best.get(hit.id);
      if (!known || hit.depth < known.depth) {
        best.set(hit.id, { id: hit.id, name: (n.metadata?.qualified as string | undefined) ?? n.name, type: n.type, ...(n.path ? { path: n.path } : {}), ...(n.startLine ? { line: n.startLine } : {}), depth: hit.depth, via: hit.via, confidence: hit.confidence });
      }
    }
  }
  for (const c of contents) best.delete(c);
  const entries = [...best.values()].sort((a, b) => a.depth - b.depth || b.confidence - a.confidence || a.id.localeCompare(b.id));
  const code = entries.filter((e) => e.type !== 'test' && e.type !== 'endpoint' && e.type !== 'table');

  const tests = new Map<string, number>();
  const tested = (path: string | undefined, depth: number) => { if (path && !tests.has(path)) tests.set(path, depth); };
  for (const e of entries) if (e.type === 'test') tested(e.path, e.depth);
  for (const c of contents) if (index.nodes.get(c)?.type === 'test') tested(index.nodes.get(c)?.path, 0);

  const apis = entries.filter((e) => e.type === 'endpoint');
  const tables = new Map<string, { name: string; access: string; from: string }>();
  const sources = [...contents, ...code.filter((e) => e.depth <= 2).map((e) => e.id)];
  for (const id of sources) {
    const n = index.nodes.get(id);
    if (n?.type === 'table') tables.set(n.name, { name: n.name, access: 'defines', from: n.path ?? n.name });
    for (const r of index.relations(id, 2000).outgoing) {
      if ((r.edge === 'READS_FROM' || r.edge === 'WRITES_TO') && r.type === 'table') {
        const access = r.edge === 'WRITES_TO' ? 'writes' : 'reads';
        const known = tables.get(r.name);
        if (!known || (known.access === 'reads' && access === 'writes')) tables.set(r.name, { name: r.name, access, from: n?.path ?? id });
      }
    }
  }

  const allNodes = [...index.nodes.values()];
  const modules = allNodes.filter((n) => n.type === 'module');
  const affected = new Set<string>();
  for (const e of entries) {
    const m = moduleOf(modules, e.path);
    if (m) affected.add(m);
  }
  for (const c of contents) {
    const m = moduleOf(modules, index.nodes.get(c)?.path);
    if (m) affected.add(m);
  }

  const breaking: BreakingHint[] = [];
  for (const c of contents) {
    const n = index.nodes.get(c);
    if (!n || n.metadata?.exported !== true || n.type === 'file') continue;
    const users = index.relations(c, 2000).incoming.filter((r: Relation) => !contents.has(r.id));
    if (users.length === 0) continue;
    breaking.push({ symbol: (n.metadata?.qualified as string | undefined) ?? n.name, type: n.type, ...(n.startLine ? { line: n.startLine } : {}), usedBy: users.length, usedByFiles: [...new Set(users.map((u) => u.path).filter((p): p is string => !!p))].sort().slice(0, 8) });
  }
  breaking.sort((a, b) => b.usedBy - a.usedBy || a.symbol.localeCompare(b.symbol));

  const decisions = memoriesForNodes(db, [...contents, ...code.filter((e) => e.depth === 1).map((e) => e.id)], 200).filter((m) => m.category === 'ARCHITECTURAL_DECISIONS')
    .map((m) => ({ id: m.id, content: m.content, source: `${m.source_kind}: ${m.source_ref}`, stale: m.status === 'stale' }));

  const targets = targetIds.map((id) => {
    const n = index.nodes.get(id);
    return { id, name: n?.name ?? id, type: n?.type ?? 'unknown', ...(n?.path ? { path: n.path } : {}) };
  });

  return {
    targets,
    direct: code.filter((e) => e.depth === 1),
    indirect: code.filter((e) => e.depth > 1),
    apis,
    tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
    tests: [...tests].map(([path, depth]) => ({ path, depth })).sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)),
    modules: [...affected].sort(),
    decisions,
    breaking: breaking.slice(0, 25),
    untested: tests.size === 0,
  };
}

const safeRev = (rev: string): string => {
  // A leading dash would be read as an option by git.
  if (!rev || rev.startsWith('-')) throw new UsageError(`"${rev}" is not a valid revision.`);
  return rev;
};

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  from?: string;
}

/** Reads `git diff --name-status -z`, whose renames carry two paths. */
export function parseNameStatus(raw: string): ChangedFile[] {
  const parts = raw.split('\0').filter((p) => p !== '');
  const out: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] ?? '';
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      const from = parts[++i] ?? '';
      const to = parts[++i] ?? '';
      out.push({ path: to, status: kind === 'R' ? 'renamed' : 'added', from });
    } else {
      const path = parts[++i] ?? '';
      out.push({ path, status: kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified' });
    }
  }
  return out;
}

const withoutOwnData = (files: ChangedFile[]): ChangedFile[] => files.filter((f) => !f.path.startsWith('.tokenistt/'));

export function stagedFiles(root: string): ChangedFile[] {
  return withoutOwnData(parseNameStatus(git(root, ['diff', '--cached', '--name-status', '-z', '--find-renames'])));
}

/** Everything differing from HEAD, including files git does not track yet. */
export function workingChanges(root: string): ChangedFile[] {
  let tracked: ChangedFile[];
  try {
    tracked = parseNameStatus(git(root, ['diff', 'HEAD', '--name-status', '-z', '--find-renames']));
  } catch {
    tracked = []; // No commits yet.
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).map((path) => ({ path, status: 'untracked' as const }));
  return withoutOwnData([...tracked, ...untracked]);
}

export function changesSince(root: string, rev: string): ChangedFile[] {
  safeRev(rev);
  return withoutOwnData(parseNameStatus(git(root, ['diff', `${rev}...HEAD`, '--name-status', '-z', '--find-renames'])));
}

export function changesAgainst(root: string, ref: string): ChangedFile[] {
  safeRev(ref);
  return withoutOwnData(parseNameStatus(git(root, ['diff', `${ref}...HEAD`, '--name-status', '-z', '--find-renames'])));
}

/** How often each file changed lately. It suggests where churn is, and says nothing about why. */
export function churn(root: string, commits = 200): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const raw = git(root, ['log', '-n', String(commits), '--name-only', '--format=%x01']);
    for (const block of raw.split('\x01')) {
      for (const f of new Set(block.split('\n').map((l) => l.trim()).filter(Boolean))) out.set(f, (out.get(f) ?? 0) + 1);
    }
  } catch {
    /* no history yet */
  }
  return out;
}

export interface ChangeRow extends ChangedFile {
  dependents: number | null;
  tests: number | null;
  commitsTouching: number;
  agentSessions: string[];
  /** Plain-language reasons this may deserve a closer look. Never a prediction that it will fail. */
  attention: string[];
}

export const FREQUENT_CHANGE = 10;
export const MANY_DEPENDENTS = 10;

export function describeChanges(files: ChangedFile[], index: GraphIndex | undefined, db: Database, root: string): ChangeRow[] {
  const history = churn(root);
  const sessionsFor = db.prepare(`SELECT DISTINCT s.agent, s.session_id FROM agent_events e JOIN agent_sessions s ON s.key = e.session_key WHERE e.path = ? AND e.type IN ('FILE_CREATED', 'FILE_MODIFIED', 'FILE_DELETED') ORDER BY s.last_event_at DESC LIMIT 5`);
  return files.map((f) => {
    const id = `file:${f.path}`;
    const known = index?.nodes.has(id);
    const hits = known && index ? index.traverse(id, 'dependents', { maxDepth: 1, limit: 500 }) : [];
    const report = known && index ? analyzeImpact(index, db, [id], { maxDepth: 3 }) : undefined;
    const agentSessions = (sessionsFor.all(f.path) as Array<{ agent: string; session_id: string }>).map((s) => `${s.agent} ${s.session_id.slice(0, 8)}`);
    const dependents = known ? new Set(hits.map((h) => index?.nodes.get(h.id)?.path).filter(Boolean)).size : null;
    const tests = report ? report.tests.length : null;
    const commitsTouching = history.get(f.path) ?? 0;
    const attention: string[] = [];
    if (dependents !== null && dependents >= MANY_DEPENDENTS) attention.push(`${dependents} files depend on it`);
    if (commitsTouching >= FREQUENT_CHANGE) attention.push(`changed in ${commitsTouching} recent commits`);
    if (tests === 0 && f.status !== 'deleted' && /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|php|cs|c|cc|cpp)$/.test(f.path)) attention.push('no test found that reaches it');
    if (f.status === 'deleted' && dependents) attention.push(`deleted, but ${dependents} files depended on it`);
    return { ...f, dependents, tests, commitsTouching, agentSessions, attention };
  });
}
