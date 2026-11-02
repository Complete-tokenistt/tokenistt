/**
 * Builds memory from things that can be pointed at: session events, commits, decision records, the graph and the
 * repository's own documents. There is no model in the loop, so it never invents an architectural decision: a decision
 * is only recorded when someone wrote one down. It is also selective: a routine command never becomes a memory.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { detectProject } from '../project/detect.js';
import { git, listFiles } from '../project/git.js';
import { listSessions, readPrices, summarize, type SessionSummary } from '../agents/sessions.js';
import { refresh } from '../agents/sessions.js';
import { GraphIndex } from '../graph/query.js';
import { readEdges, readMetadata, readNodes } from '../graph/store.js';
import type { Database } from '../store/db.js';
import type { Project } from '../store/project.js';
import { markStale, remember, type Category, type Memory, type NewMemory, type SourceKind } from './store.js';

const DAY = 86_400_000;
const MAX_DOC_BYTES = 256 * 1024;
const list = (items: string[], max = 6): string => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

export interface ExtractResult {
  created: number;
  updated: number;
  unchanged: number;
  staled: number;
  sessions: number;
}

interface Draft extends Omit<NewMemory, 'category' | 'sourceKind' | 'sourceRef' | 'content'> {
  category: Category;
  content: string;
  sourceKind: SourceKind;
  sourceRef: string;
}

const fileNode = (p: string): string => `file:${p}`;

/** What a finished session leaves behind. Sessions that only read things and changed nothing are not worth keeping. */
export function draftsFromSession(s: SessionSummary, now: Date): Draft[] {
  const changed = [...s.files.created, ...s.files.modified, ...s.files.deleted];
  const out: Draft[] = [];
  const ref = s.key;
  const nodes = changed.map(fileNode);
  const when = s.startedAt.slice(0, 10);
  const c = s.counts;
  const tests = c.testsPassed + c.testsFailed + c.testsUnknown;
  if (changed.length > 0 || c.errors > 0) {
    const parts = [`${s.agent} session on ${s.branch ?? 'an unknown branch'} (${when})`];
    if (changed.length) parts.push(`changed ${changed.length} file${changed.length === 1 ? '' : 's'}: ${list(changed)}`);
    if (tests) parts.push(`tests: ${c.testsPassed} passed, ${c.testsFailed} failed${c.testsUnknown ? `, ${c.testsUnknown} unknown` : ''}`);
    if (c.errors) parts.push(`${c.errors} tool error${c.errors === 1 ? '' : 's'}`);
    out.push({
      category: 'AGENT_SESSION_SUMMARIES', content: `${parts.join('; ')}.`, sourceKind: 'session', sourceRef: ref, confidence: 0.9, relevance: 0.4, dedupeKey: `session-summary:${s.key}`,
      nodes, sessions: [s.key], reviewAt: new Date(now.getTime() + 60 * DAY).toISOString(), now,
    });
  }
  if (changed.length >= 3) {
    const areas = [...new Set(changed.map((f) => { const dir = posix.dirname(f).split('/').slice(0, 2).join('/'); return dir === '.' ? 'the repository root' : dir; }))];
    out.push({
      category: 'IMPLEMENTATION_PROGRESS', content: `Work on ${list(areas, 4)} in session ${s.id.slice(0, 8)} on ${s.branch ?? 'an unknown branch'}: ${s.files.created.length} files added, ${s.files.modified.length} changed, ${s.files.deleted.length} removed.`,
      sourceKind: 'session', sourceRef: ref, confidence: 0.7, relevance: 0.45, dedupeKey: `progress:${s.key}`, nodes, sessions: [s.key], reviewAt: new Date(now.getTime() + 30 * DAY).toISOString(), now,
    });
  }
  return out;
}

/** Test outcome over time, in order, because the last result is what says whether something is still broken. */
function testResults(db: Database, key: string): Array<{ ok: number | null; command: string | null; at: string }> {
  return db.prepare(`SELECT ok, command, at FROM agent_events WHERE session_key = ? AND type = 'TEST_EXECUTED' AND ok IS NOT NULL ORDER BY at, rowid`).all(key) as unknown as Array<{ ok: number | null; command: string | null; at: string }>;
}

function testMemories(db: Database, projectId: string, sessions: SessionSummary[], now: Date, tally: (o: string) => void): void {
  const ordered = [...sessions].sort((a, b) => a.lastEventAt.localeCompare(b.lastEventAt));
  for (const s of ordered) {
    const results = testResults(db, s.key);
    const last = results[results.length - 1];
    if (!last) continue;
    const changed = [...s.files.created, ...s.files.modified, ...s.files.deleted];
    const branch = s.branch ?? 'unknown';
    if (results.some((r) => r.ok === 0) && last.ok === 1) {
      const r = remember(db, projectId, {
        category: 'DEBUGGING_HISTORY', content: `In session ${s.id.slice(0, 8)} on ${branch}, tests failed and then passed${changed.length ? `, with changes to ${list(changed)}` : ''}.`,
        sourceKind: 'session', sourceRef: s.key, confidence: 0.75, relevance: 0.5, dedupeKey: `debugging:${s.key}`, nodes: changed.map(fileNode), sessions: [s.key], now,
      });
      tally(r.outcome);
    }
    const issueKey = `tests-failing:${branch}`;
    if (last.ok === 0) {
      const r = remember(db, projectId, {
        category: 'KNOWN_ISSUES', content: `Tests were failing on ${branch} at the end of session ${s.id.slice(0, 8)} (${s.lastEventAt.slice(0, 10)})${last.command ? `, running ${last.command}` : ''}.`,
        sourceKind: 'session', sourceRef: s.key, confidence: 0.8, relevance: 0.8, dedupeKey: issueKey, nodes: changed.map(fileNode), sessions: [s.key], now,
      });
      tally(r.outcome);
    } else {
      // A later pass on the same branch contradicts the open issue.
      const open = db.prepare(`SELECT id FROM memories WHERE dedupe_key = ? AND status = 'active'`).get(issueKey) as { id: string } | undefined;
      if (open) {
        markStale(db, open.id, `Tests passed in a later session, ${s.id.slice(0, 8)}.`, now);
        tally('staled');
      }
    }
  }
}

const DECISION_FILE = /(^|\/)(adr|adrs|decisions?)\/[^/]+\.md$|(^|\/)(adr|decision)[-_ ][^/]*\.md$/i;

/** Decision records as written, one memory each. A record marked superseded or rejected is not a current decision. */
function decisionDrafts(root: string, files: string[], now: Date): Draft[] {
  const out: Draft[] = [];
  for (const f of files.filter((p) => DECISION_FILE.test(p))) {
    const abs = join(root, f);
    if (statSync(abs, { throwIfNoEntry: false })?.size === undefined || (statSync(abs).size > MAX_DOC_BYTES)) continue;
    const text = readFileSync(abs, 'utf8');
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? posix.basename(f, '.md');
    const status = /^(?:#+\s*)?status:?\s*\n*\s*([A-Za-z-]+)/im.exec(text)?.[1]?.toLowerCase();
    if (status && /^(superseded|deprecated|rejected)/.test(status)) continue;
    const decision = /^#+\s*decision\s*\n+([\s\S]*?)(?:\n#|$)/im.exec(text)?.[1]?.replace(/\s+/g, ' ').trim();
    const body = decision ? `: ${decision.slice(0, 400)}` : '';
    out.push({ category: 'ARCHITECTURAL_DECISIONS', content: `${title}${status ? ` (${status})` : ''}${body}`, sourceKind: 'file', sourceRef: f, confidence: 1, relevance: 0.9, dedupeKey: `decision-file:${f}`, nodes: [fileNode(f)], now });
  }
  return out;
}

/** Commits can state a decision with a `Decision:` trailer; everything else is just a change. */
function commitDrafts(root: string, now: Date): Draft[] {
  const out: Draft[] = [];
  let raw: string;
  try {
    raw = git(root, ['log', '-n', '30', '--name-only', '--format=%x01%H%x09%ad%x09%s%x09%(trailers:key=Decision,valueonly,separator=%x1f)', '--date=short']);
  } catch {
    return out;
  }
  for (const block of raw.split('\x01').filter(Boolean)) {
    const [head = '', ...rest] = block.split('\n');
    const [hash = '', date = '', subject = '', decisions = ''] = head.split('\t');
    if (!hash) continue;
    const files = rest.map((l) => l.trim()).filter(Boolean);
    const nodes = files.map(fileNode);
    out.push({
      category: 'RECENT_CHANGES', content: `${date}: ${subject} (${hash.slice(0, 7)}${files.length ? `, ${files.length} file${files.length === 1 ? '' : 's'}` : ''}).`, sourceKind: 'commit', sourceRef: hash, confidence: 1, relevance: 0.35,
      dedupeKey: `commit:${hash}`, nodes, reviewAt: new Date(now.getTime() + 30 * DAY).toISOString(), now,
    });
    for (const d of decisions.split('\x1f').map((x) => x.trim()).filter(Boolean)) {
      out.push({ category: 'ARCHITECTURAL_DECISIONS', content: d, sourceKind: 'commit', sourceRef: hash, confidence: 1, relevance: 0.9, dedupeKey: `decision-commit:${hash}:${createHash('sha256').update(d).digest('hex').slice(0, 8)}`, nodes, now });
    }
  }
  return out;
}

const CONVENTION_DOCS = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', 'CODE_STYLE.md', 'STYLEGUIDE.md', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'GEMINI.md'];

/** First real paragraph of the README: the project's own description of itself. */
export function readmeSummary(text: string): string | undefined {
  const lines = text.split('\n');
  const para: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const skip = !line || line.startsWith('#') || line.startsWith('![') || line.startsWith('[![') || line.startsWith('<') || line.startsWith('---') || line.startsWith('```') || line.startsWith('|');
    if (skip) {
      if (para.length) break;
      continue;
    }
    para.push(line);
  }
  const out = para.join(' ').replace(/\s+/g, ' ').trim();
  return out ? out.slice(0, 500) : undefined;
}

function documentDrafts(root: string, files: string[], now: Date): Draft[] {
  const out: Draft[] = [];
  const known = new Set(files);
  const readme = ['README.md', 'readme.md', 'Readme.md'].find((f) => known.has(f));
  if (readme && statSync(join(root, readme)).size <= MAX_DOC_BYTES) {
    const summary = readmeSummary(readFileSync(join(root, readme), 'utf8'));
    if (summary) out.push({ category: 'PROJECT_OVERVIEW', content: summary, sourceKind: 'file', sourceRef: readme, confidence: 0.9, relevance: 0.85, dedupeKey: 'overview:readme', nodes: [fileNode(readme)], now });
  }
  const docs = CONVENTION_DOCS.filter((f) => known.has(f));
  // These are pointed at, not copied: agents can read the source, which stays authoritative.
  if (docs.length) out.push({ category: 'CODING_CONVENTIONS', content: `Conventions are written down in ${list(docs)}.`, sourceKind: 'file', sourceRef: docs.join(', '), confidence: 1, relevance: 0.7, dedupeKey: 'conventions:docs', nodes: docs.map(fileNode), now });
  const d = detectProject(root, files);
  const stack = [d.languages.slice(0, 6).map((l) => l.language).join(', '), d.frameworks.join(', '), d.packageManagers.join(', ')];
  if (stack[0] || stack[1]) {
    out.push({ category: 'TECH_STACK', content: `Languages: ${stack[0] || 'none detected'}. Frameworks: ${stack[1] || 'none detected'}. Package managers: ${stack[2] || 'none detected'}.`, sourceKind: 'detection', sourceRef: 'file names and manifests', confidence: 0.9, relevance: 0.75, dedupeKey: 'stack', now });
  }
  return out;
}

function graphDrafts(db: Database, now: Date): Draft[] {
  if (!readMetadata(db)) return [];
  const out: Draft[] = [];
  const nodes = readNodes(db);
  const edges = readEdges(db);
  const index = new GraphIndex(nodes, edges);
  const modules = nodes.filter((n) => n.type === 'module');
  const deps = edges.filter((e) => e.type === 'DEPENDS_ON' && e.source.startsWith('module:') && e.target.startsWith('module:'));
  const name = (id: string) => index.nodes.get(id)?.name ?? id;
  if (modules.length > 1) {
    const links = deps.map((e) => `${name(e.source)} uses ${name(e.target)}`);
    out.push({ category: 'ARCHITECTURE', content: `${modules.length} modules: ${list(modules.map((m) => m.name), 12)}.${links.length ? ` ${list(links, 12)}.` : ''}`, sourceKind: 'graph', sourceRef: 'module dependencies', confidence: 0.95, relevance: 0.8, dedupeKey: 'architecture:modules', nodes: modules.map((m) => m.id), now });
  }
  const routes = nodes.filter((n) => n.type === 'endpoint').length;
  const tables = nodes.filter((n) => n.type === 'table').length;
  const services = nodes.filter((n) => n.type === 'service').length;
  if (routes || tables || services) {
    out.push({ category: 'ARCHITECTURE', content: `The graph finds ${routes} API routes, ${tables} database tables and ${services} deployed services.`, sourceKind: 'graph', sourceRef: 'graph counts', confidence: 0.85, relevance: 0.55, dedupeKey: 'architecture:surface', now });
  }
  const incoming = new Map<string, number>();
  for (const e of edges) if (e.type === 'IMPORTS' && e.target.startsWith('pkg:') && !e.target.startsWith('pkg:node:')) incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
  const top = [...incoming].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  if (top.length) {
    out.push({ category: 'IMPORTANT_DEPENDENCIES', content: `Most imported packages: ${top.map(([id, c]) => `${name(id)} (${c} files)`).join(', ')}.`, sourceKind: 'graph', sourceRef: 'import counts', confidence: 0.95, relevance: 0.6, dedupeKey: 'dependencies:top', nodes: top.map(([id]) => id), now });
  }
  for (const m of modules) {
    const dir = m.path && m.path !== '.' ? `dir:${m.path}` : undefined;
    const size = dir ? index.view(dir)?.descendants ?? 0 : 0;
    if (!dir || size < 5) continue;
    const prefix = `${m.path}/`;
    const inside = nodes.filter((n) => n.path?.startsWith(prefix));
    const entry = inside.find((n) => n.metadata?.entryPoint === true);
    const used = index.mostUsed(2000).filter((u) => u.path?.startsWith(prefix) && u.type !== 'file').slice(0, 3);
    const count = (t: string) => inside.filter((n) => n.type === t).length;
    const bits = [`${m.name} is in ${m.path}`, `${count('file')} files, ${count('function') + count('method')} functions and methods`];
    if (count('endpoint')) bits.push(`${count('endpoint')} API routes`);
    if (count('component')) bits.push(`${count('component')} components`);
    if (entry?.path) bits.push(`entry point ${entry.path}`);
    if (used.length) bits.push(`most used: ${used.map((u) => u.name).join(', ')}`);
    out.push({ category: 'MODULE_CONTEXT', content: `${bits.join('; ')}.`, sourceKind: 'graph', sourceRef: m.id, confidence: 0.9, relevance: 0.55, dedupeKey: `module:${m.path}`, nodes: [m.id, ...(entry ? [entry.id] : [])], now });
  }
  return out;
}

/** Flags memories whose subject is gone, or whose review date has passed. They stay readable, marked as stale. */
function reviewStaleness(db: Database, now: Date): number {
  let staled = 0;
  const hasGraph = !!readMetadata(db);
  const nodeExists = db.prepare('SELECT 1 FROM graph_nodes WHERE id = ?');
  const active = db.prepare(`SELECT * FROM memories WHERE status = 'active'`).all() as unknown as Memory[];
  for (const m of active) {
    if (m.review_at && m.review_at < now.toISOString()) {
      markStale(db, m.id, `Not confirmed since ${m.updated_at.slice(0, 10)}.`, now);
      staled++;
      continue;
    }
    if (!hasGraph || m.source_kind === 'commit' || m.source_kind === 'session') continue;
    const links = db.prepare('SELECT node_id FROM memory_nodes WHERE memory_id = ?').all(m.id) as Array<{ node_id: string }>;
    const missing = links.filter((l) => !nodeExists.get(l.node_id));
    if (links.length > 0 && missing.length === links.length) {
      markStale(db, m.id, `What this refers to is no longer in the graph: ${missing[0]?.node_id}.`, now);
      staled++;
    }
  }
  return staled;
}

export function extractMemories(project: Project, db: Database, now: Date = new Date()): ExtractResult {
  const { root } = project.repo;
  const projectId = project.config.projectId;
  refresh(root, db);
  const result: ExtractResult = { created: 0, updated: 0, unchanged: 0, staled: 0, sessions: 0 };
  const tally = (o: string): void => {
    if (o === 'created') result.created++;
    else if (o === 'updated') result.updated++;
    else if (o === 'unchanged') result.unchanged++;
    else if (o === 'staled') result.staled++;
  };
  const apply = (d: Draft): void => {
    const { category, content, sourceKind, sourceRef, ...rest } = d;
    tally(remember(db, projectId, { category, content, sourceKind, sourceRef, ...rest }).outcome);
  };

  const prices = readPrices(root);
  const finished = listSessions(db, { limit: 200 }).map((r) => summarize(db, r, now.getTime(), prices)).filter((s) => s.state === 'ended' || s.state === 'inactive');
  result.sessions = finished.length;
  for (const s of finished) for (const d of draftsFromSession(s, now)) apply(d);
  testMemories(db, projectId, finished, now, tally);

  let files: string[] = [];
  try {
    files = listFiles(root).filter((f) => existsSync(join(root, f)));
  } catch {
    files = [];
  }
  for (const d of [...decisionDrafts(root, files, now), ...documentDrafts(root, files, now), ...commitDrafts(root, now), ...graphDrafts(db, now)]) apply(d);
  result.staled += reviewStaleness(db, now);
  return result;
}
