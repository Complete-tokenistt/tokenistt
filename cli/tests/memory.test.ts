import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { handleHook } from '../src/agents/hook-main.js';
import { indexProject } from '../src/graph/indexer.js';
import { extractMemories, readmeSummary } from '../src/memory/extract.js';
import { editMemory, ftsQuery, getMemory, linkedNodes, listMemories, memoriesForNodes, memoryHistory, memoryStats, parseCategory, remember, retireMemory, searchMemories } from '../src/memory/store.js';
import { repoInfo } from '../src/project/git.js';
import { openDatabase } from '../src/store/db.js';
import { initProject } from '../src/store/project.js';
import { gitRepo, runCli } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function setup(files: Record<string, string> = { 'a.ts': 'export function a() {}' }) {
  const t = gitRepo(files);
  cleanups.push(t.cleanup);
  const { project } = initProject(repoInfo(t.dir)!);
  const db = openDatabase(t.dir);
  cleanups.push(() => db.close());
  return { t, db, project };
}
const T0 = new Date('2026-11-02T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const send = (dir: string, name: string, extra: Record<string, unknown>, session: string, now: Date) => handleHook('claude-code', JSON.stringify({ session_id: session, hook_event_name: name, cwd: dir, ...extra }), now);
const edit = (dir: string, file: string, session: string, id: string, now: Date) => send(dir, 'PostToolUse', { tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: join(dir, file) } }, session, now);
const test = (dir: string, ok: boolean, session: string, id: string, now: Date) => send(dir, ok ? 'PostToolUse' : 'PostToolUseFailure', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'npm test' } }, session, now);
const end = (dir: string, session: string, now: Date) => send(dir, 'SessionEnd', { reason: 'other' }, session, now);
const inCat = (db: ReturnType<typeof openDatabase>, c: string) => listMemories(db, { category: parseCategory(c) });

describe('memory store', () => {
  it('records provenance and scrubs credentials', () => {
    const { db } = setup();
    const r = remember(db, 'p', { category: 'OPEN_TASKS', content: 'Rotate key sk-abcdefghijklmnopqrstuvwx soon', sourceKind: 'user', sourceRef: 'cli', nodes: ['file:a.ts'] });
    const m = getMemory(db, r.id);
    assert.doesNotMatch(m.content, /abcdefghijklmnop/);
    assert.equal(m.source_kind, 'user');
    assert.equal(m.source_ref, 'cli');
    assert.deepEqual(linkedNodes(db, r.id), ['file:a.ts']);
    assert.ok(m.created_at && m.updated_at);
    assert.throws(() => remember(db, 'p', { category: 'OPEN_TASKS', content: '   ', sourceKind: 'user', sourceRef: 'x' }), /some content/);
  });
  it('is idempotent on a dedupe key, and keeps history when the content changes', () => {
    const { db } = setup();
    const base = { category: 'TECH_STACK' as const, sourceKind: 'detection' as const, sourceRef: 'x', dedupeKey: 'stack' };
    const one = remember(db, 'p', { ...base, content: 'Node 20', now: at(0) });
    assert.equal(remember(db, 'p', { ...base, content: 'Node 20', now: at(1) }).outcome, 'unchanged');
    const two = remember(db, 'p', { ...base, content: 'Node 22', now: at(2) });
    assert.equal(two.outcome, 'updated');
    assert.deepEqual(inCat(db, 'TECH_STACK').map((m) => m.content), ['Node 22']);
    const old = getMemory(db, one.id);
    assert.equal(old.status, 'superseded');
    assert.equal(old.superseded_by, two.id);
    assert.deepEqual(memoryHistory(db, two.id).map((m) => m.content), ['Node 20', 'Node 22']);
    assert.deepEqual(memoryHistory(db, one.id).map((m) => m.content), ['Node 20', 'Node 22']);
    assert.equal(searchMemories(db, 'Node').length, 1);
    assert.equal(searchMemories(db, 'Node')[0]?.content, 'Node 22');
  });
  it('editing never loses what it said, and a superseded version cannot be edited', () => {
    const { db } = setup();
    const a = remember(db, 'p', { category: 'OPEN_TASKS', content: 'first', sourceKind: 'user', sourceRef: 'x' });
    const b = editMemory(db, a.id, 'second');
    assert.deepEqual(memoryHistory(db, b).map((m) => m.content), ['first', 'second']);
    assert.equal(getMemory(db, b).source_kind, 'user');
    assert.throws(() => editMemory(db, a.id, 'third'), /has been replaced/);
  });
  it('retiring hides a memory but keeps it', () => {
    const { db } = setup();
    const a = remember(db, 'p', { category: 'OPEN_TASKS', content: 'unique-word-here', sourceKind: 'user', sourceRef: 'x' });
    retireMemory(db, a.id, 'done');
    assert.equal(listMemories(db).length, 0);
    assert.equal(searchMemories(db, 'unique').length, 0);
    assert.equal(listMemories(db, { includeInactive: true }).length, 1);
    assert.equal(getMemory(db, a.id).stale_reason, 'done');
  });
  it('search ranks matches, tolerates FTS syntax in the query, and finds by prefix', () => {
    const { db } = setup();
    remember(db, 'p', { category: 'ARCHITECTURE', content: 'Authentication uses JWT sessions', sourceKind: 'user', sourceRef: 'x', relevance: 0.9 });
    remember(db, 'p', { category: 'OPEN_TASKS', content: 'Tidy logging', sourceKind: 'user', sourceRef: 'x' });
    assert.equal(searchMemories(db, 'authentication architecture')[0]?.content, 'Authentication uses JWT sessions');
    assert.equal(searchMemories(db, 'auth').length, 1);
    for (const nasty of ['"', 'a AND', '*', '(x', 'NEAR(', 'col:val', "'; DROP TABLE memories; --"]) assert.doesNotThrow(() => searchMemories(db, nasty), nasty);
    assert.deepEqual(searchMemories(db, '!!!'), []);
    assert.equal(ftsQuery('a-b'), '"a"* OR "b"*');
    assert.ok(memoryStats(db).active === 2);
  });
  it('finds memories by what they are about', () => {
    const { db } = setup();
    remember(db, 'p', { category: 'KNOWN_ISSUES', content: 'flaky', sourceKind: 'user', sourceRef: 'x', nodes: ['file:a.ts'] });
    assert.equal(memoriesForNodes(db, ['file:a.ts'])[0]?.content, 'flaky');
    assert.deepEqual(memoriesForNodes(db, ['file:b.ts']), []);
    assert.deepEqual(memoriesForNodes(db, []), []);
  });
  it('rejects unknown categories, and accepts friendly spelling', () => {
    assert.equal(parseCategory('open-tasks'), 'OPEN_TASKS');
    assert.throws(() => parseCategory('stuff'), /Unknown category/);
  });
});

describe('extraction from sessions', () => {
  it('summarizes finished sessions, linked to code, and skips ones that changed nothing', () => {
    const { t, db, project } = setup();
    edit(t.dir, 'a.ts', 'worker', '1', at(0));
    end(t.dir, 'worker', at(1));
    send(t.dir, 'PostToolUse', { tool_name: 'Read', tool_use_id: '2', tool_input: { file_path: join(t.dir, 'a.ts') } }, 'reader', at(0));
    end(t.dir, 'reader', at(1));
    extractMemories(project, db, at(2));
    const summaries = inCat(db, 'AGENT_SESSION_SUMMARIES');
    assert.equal(summaries.length, 1);
    assert.match(summaries[0]?.content ?? '', /changed 1 file: a\.ts/);
    assert.equal(summaries[0]?.source_kind, 'session');
    assert.equal(summaries[0]?.source_ref, 'claude-code:worker');
    assert.deepEqual(linkedNodes(db, summaries[0]!.id), ['file:a.ts']);
  });
  it('ignores a session still in progress, and treats routine commands as nothing', () => {
    const { t, db, project } = setup();
    edit(t.dir, 'a.ts', 'running', '1', at(0));
    send(t.dir, 'PostToolUse', { tool_name: 'Bash', tool_use_id: '2', tool_input: { command: 'ls -la' } }, 'cmds', at(0));
    end(t.dir, 'cmds', at(1));
    extractMemories(project, db, at(2));
    assert.equal(inCat(db, 'AGENT_SESSION_SUMMARIES').length, 0);
    assert.equal(JSON.stringify(listMemories(db)).includes('ls -la'), false);
  });
  it('a quiet session counts as finished', () => {
    const { t, db, project } = setup();
    edit(t.dir, 'a.ts', 'forgotten', '1', at(0));
    extractMemories(project, db, at(120));
    assert.equal(inCat(db, 'AGENT_SESSION_SUMMARIES').length, 1);
  });
  it('tracks progress only for real work', () => {
    const { t, db, project } = setup();
    for (const [i, f] of ['x/a.ts', 'x/b.ts', 'y/c.ts'].entries()) edit(t.dir, f, 'big', `e${i}`, at(i));
    end(t.dir, 'big', at(5));
    edit(t.dir, 'a.ts', 'small', 'z', at(0));
    end(t.dir, 'small', at(1));
    extractMemories(project, db, at(6));
    const progress = inCat(db, 'IMPLEMENTATION_PROGRESS');
    assert.equal(progress.length, 1);
    assert.match(progress[0]?.content ?? '', /x, y|y, x/);
  });
  it('records failing tests as an issue, resolves it when they pass later on that branch, and keeps the history', () => {
    const { t, db, project } = setup();
    test(t.dir, false, 'bad', '1', at(0));
    end(t.dir, 'bad', at(1));
    extractMemories(project, db, at(2));
    const issue = inCat(db, 'KNOWN_ISSUES')[0];
    assert.match(issue?.content ?? '', /Tests were failing on main/);
    assert.equal(issue?.status, 'active');
    test(t.dir, true, 'good', '2', at(10));
    end(t.dir, 'good', at(11));
    const r = extractMemories(project, db, at(12));
    assert.ok(r.staled >= 1);
    const after = getMemory(db, issue!.id);
    assert.equal(after.status, 'stale');
    assert.match(after.stale_reason ?? '', /passed in a later session, good/);
  });
  it('does not resolve an issue from a pass on another branch', () => {
    const { t, db, project } = setup();
    test(t.dir, false, 'bad', '1', at(0));
    end(t.dir, 'bad', at(1));
    extractMemories(project, db, at(2));
    t.git('checkout', '-q', '-b', 'other');
    test(t.dir, true, 'elsewhere', '2', at(10));
    end(t.dir, 'elsewhere', at(11));
    extractMemories(project, db, at(12));
    assert.equal(inCat(db, 'KNOWN_ISSUES')[0]?.status, 'active');
  });
  it('recognises tests that failed and then passed', () => {
    const { t, db, project } = setup();
    edit(t.dir, 'a.ts', 'fix', '0', at(0));
    test(t.dir, false, 'fix', '1', at(1));
    test(t.dir, true, 'fix', '2', at(2));
    end(t.dir, 'fix', at(3));
    extractMemories(project, db, at(4));
    assert.match(inCat(db, 'DEBUGGING_HISTORY')[0]?.content ?? '', /failed and then passed, with changes to a\.ts/);
  });
  it('running twice changes nothing', () => {
    const { t, db, project } = setup({ 'README.md': 'A tool.\n', 'a.ts': 'x' });
    edit(t.dir, 'a.ts', 's', '1', at(0));
    end(t.dir, 's', at(1));
    extractMemories(project, db, at(2));
    const before = memoryStats(db).total;
    const again = extractMemories(project, db, at(3));
    assert.equal(again.created, 0);
    assert.equal(again.updated, 0);
    assert.ok(again.unchanged > 0);
    assert.equal(memoryStats(db).total, before);
  });
  it('a summary goes stale after its review date, and a fresh confirmation restores it', () => {
    const { t, db, project } = setup();
    edit(t.dir, 'a.ts', 's', '1', at(0));
    end(t.dir, 's', at(1));
    extractMemories(project, db, at(2));
    const id = inCat(db, 'AGENT_SESSION_SUMMARIES')[0]!.id;
    extractMemories(project, db, new Date(at(2).getTime() + 200 * 86_400_000));
    assert.equal(getMemory(db, id).status, 'active', 'still derivable from the session, so it is renewed');
    assert.equal(memoryHistory(db, id).length, 1);
  });
});

describe('extraction from the repository', () => {
  it('records decisions only where someone wrote one down', () => {
    const { db, project } = setup({
      'docs/adr/0001-use-postgres.md': '# Use Postgres\n\n## Status\n\nAccepted\n\n## Decision\n\nWe use a single Postgres instance.\n',
      'docs/adr/0002-old.md': '# Use MySQL\n\n## Status\n\nSuperseded by 0001\n',
      'docs/decisions/caching.md': '# Cache in Redis\n',
      'docs/guide.md': '# We decided nothing here\n',
      'src/db.ts': 'export const pool = new Pool();\n',
    });
    extractMemories(project, db, at(0));
    const d = inCat(db, 'ARCHITECTURAL_DECISIONS');
    assert.deepEqual(d.map((m) => m.source_ref).sort(), ['docs/adr/0001-use-postgres.md', 'docs/decisions/caching.md']);
    assert.match(d.find((m) => m.source_ref.includes('0001'))?.content ?? '', /Use Postgres \(accepted\): We use a single Postgres instance\./);
    assert.ok(d.every((m) => m.confidence === 1));
  });
  it('supersedes a decision when its record changes, and goes stale if the file is removed', async () => {
    const { t, db, project } = setup({ 'docs/adr/1.md': '# Use A\n', 'a.ts': 'x' });
    await indexProject(project, db);
    extractMemories(project, db, at(0));
    const first = inCat(db, 'ARCHITECTURAL_DECISIONS')[0]!;
    writeFileSync(join(t.dir, 'docs/adr/1.md'), '# Use B\n');
    extractMemories(project, db, at(1));
    assert.equal(inCat(db, 'ARCHITECTURAL_DECISIONS')[0]?.content, 'Use B');
    assert.equal(getMemory(db, first.id).status, 'superseded');
    t.git('rm', '-qf', 'docs/adr/1.md');
    await indexProject(project, db);
    extractMemories(project, db, at(2));
    const gone = listMemories(db, { category: 'ARCHITECTURAL_DECISIONS' })[0];
    assert.equal(gone?.status, 'stale');
    assert.match(gone?.stale_reason ?? '', /no longer in the graph/);
  });
  it('reads Decision trailers from commits, and each commit as a recent change', () => {
    const { t, db, project } = setup();
    writeFileSync(join(t.dir, 'b.ts'), 'y');
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'feat: add b\n\nDecision: Keep b separate from a');
    extractMemories(project, db, at(0));
    assert.deepEqual(inCat(db, 'ARCHITECTURAL_DECISIONS').map((m) => m.content), ['Keep b separate from a']);
    const recent = inCat(db, 'RECENT_CHANGES').map((m) => m.content);
    assert.ok(recent.some((c) => /feat: add b \(\w+, \d+ files?\)/.test(c)), JSON.stringify(recent));
    assert.equal(inCat(db, 'RECENT_CHANGES')[0]?.source_kind, 'commit');
  });
  it('takes the overview from the README, the stack from detection, and points at conventions rather than copying them', () => {
    const { db, project } = setup({
      'README.md': '# Thing\n\n[![badge](x)](y)\n\nThing keeps your plants watered\nwhile you travel.\n\nSecond paragraph.\n',
      'CONTRIBUTING.md': 'Use tabs. SECRET_CONVENTION_TEXT\n',
      'package.json': JSON.stringify({ dependencies: { express: '5' } }),
      'a.ts': 'x',
    });
    extractMemories(project, db, at(0));
    assert.equal(inCat(db, 'PROJECT_OVERVIEW')[0]?.content, 'Thing keeps your plants watered while you travel.');
    assert.match(inCat(db, 'TECH_STACK')[0]?.content ?? '', /Frameworks: express/);
    const conv = inCat(db, 'CODING_CONVENTIONS')[0];
    assert.match(conv?.content ?? '', /written down in CONTRIBUTING\.md/);
    assert.doesNotMatch(conv?.content ?? '', /SECRET_CONVENTION_TEXT/);
  });
  it('builds architecture, module context and dependencies from the graph', async () => {
    const { db, project } = setup({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { core: '*', react: '19' } }),
      'apps/web/src/index.ts': "import { c } from 'core'; import React from 'react'; c();\n",
      'apps/web/src/a.ts': "import React from 'react';\n",
      'apps/web/src/b.ts': 'export const b = 1;\n',
      'apps/web/src/c.ts': 'export const c = 1;\n',
      'packages/core/package.json': JSON.stringify({ name: 'core', main: 'src/index.ts' }),
      'packages/core/src/index.ts': 'export function c() {}\n',
      'packages/core/src/d.ts': 'export function d() {}\n',
      'packages/core/src/e.ts': 'export function e() {}\n',
      'packages/core/src/f.ts': 'export function f() {}\n',
    });
    await indexProject(project, db);
    extractMemories(project, db, at(0));
    const arch = inCat(db, 'ARCHITECTURE').map((m) => m.content).join(' ');
    assert.match(arch, /2 modules: /);
    assert.match(arch, /web uses core/);
    assert.match(inCat(db, 'IMPORTANT_DEPENDENCIES')[0]?.content ?? '', /react \(2 files\)/);
    assert.ok(inCat(db, 'MODULE_CONTEXT').some((m) => /core is in packages\/core; 5 files.*entry point packages\/core\/src\/index\.ts/.test(m.content)));
  });
  it('works with no graph, no commits and nothing else', () => {
    const { db, project } = setup({});
    assert.doesNotThrow(() => extractMemories(project, db, at(0)));
  });
  it('reads README summaries robustly', () => {
    assert.equal(readmeSummary('# T\n\n<img src=x>\n\nReal text.\n'), 'Real text.');
    assert.equal(readmeSummary('# Only a title\n'), undefined);
    assert.equal(readmeSummary('```\ncode\n```\n'), 'code');
  });
});

describe('tokenistt memory (end to end)', () => {
  const repo = (files: Record<string, string> = { 'README.md': 'A demo.\n', 'a.ts': 'x' }) => {
    const t = gitRepo(files);
    cleanups.push(t.cleanup);
    runCli(t.dir, ['init']);
    return t;
  };
  it('guides you when empty, then updates and shows provenance', () => {
    const t = repo();
    assert.match(runCli(t.dir, ['memory']).out, /Nothing remembered yet/);
    assert.match(runCli(t.dir, ['memory', 'show']).out, /Nothing to show/);
    const u = runCli(t.dir, ['memory', 'update']);
    assert.equal(u.code, 0, u.err);
    assert.match(u.out, /\d+ new/);
    const shown = runCli(t.dir, ['memory', 'show']);
    assert.match(shown.out, /Project overview/);
    assert.match(shown.out, /from file: README\.md/);
    assert.ok(existsSync(join(t.dir, '.tokenistt', 'memory', 'project-memory.json')));
    assert.ok(existsSync(join(t.dir, '.tokenistt', 'memory', 'decisions.json')));
    assert.ok(JSON.parse(runCli(t.dir, ['memory', '--json']).out).active > 0);
  });
  it('adds, searches, edits, shows versions and forgets', () => {
    const t = repo();
    const added = JSON.parse(runCli(t.dir, ['memory', 'add', 'Moving auth to sessions', '--category', 'open-tasks', '--about', 'a.ts', '--json']).out);
    assert.equal(added.outcome, 'created');
    assert.match(runCli(t.dir, ['memory', 'search', 'authentication']).out, /Nothing mentions/);
    assert.match(runCli(t.dir, ['memory', 'search', 'auth']).out, /Moving auth/);
    const edited = JSON.parse(runCli(t.dir, ['memory', 'edit', added.id, 'Moved auth to sessions', '--json']).out);
    const detail = runCli(t.dir, ['memory', 'show', '--id', edited.id]);
    assert.match(detail.out, /Versions/);
    assert.match(detail.out, /Moving auth to sessions/);
    assert.match(detail.out, /file:a\.ts/);
    assert.equal(runCli(t.dir, ['memory', 'forget', edited.id]).code, 0);
    assert.match(runCli(t.dir, ['memory', 'search', 'auth']).out, /Nothing mentions/);
    assert.match(runCli(t.dir, ['memory', 'show', '--all', '--category', 'open_tasks']).out, /retired/);
    assert.equal(runCli(t.dir, ['memory', 'add', 'x', '--category', 'nope']).code, 2);
    assert.equal(runCli(t.dir, ['memory', 'show', '--id', 'mem_zzzz']).code, 2);
  });
  it('exports markdown and JSON, to stdout and a file', () => {
    const t = repo();
    runCli(t.dir, ['memory', 'update']);
    const md = runCli(t.dir, ['memory', 'export']);
    assert.match(md.out, /^# Project memory/);
    assert.match(md.out, /_\(from file: README\.md\)_/);
    assert.ok(Array.isArray(JSON.parse(runCli(t.dir, ['memory', 'export', '--format', 'json']).out)));
    const file = join(t.dir, 'out.md');
    mkdirSync(dirname(file), { recursive: true });
    assert.equal(runCli(t.dir, ['memory', 'export', '--out', file]).code, 0);
    assert.match(readFileSync(file, 'utf8'), /Project memory/);
    assert.equal(runCli(t.dir, ['memory', 'export', '--format', 'xml']).code, 2);
    assert.match(runCli(t.dir, ['memory', 'stats']).out, /active/);
  });
});
