import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleHook } from '../src/agents/hook-main.js';
import { refresh } from '../src/agents/sessions.js';
import { indexProject } from '../src/graph/indexer.js';
import { GraphIndex } from '../src/graph/query.js';
import { analyzeImpact, changesAgainst, changesSince, churn, describeChanges, parseNameStatus, resolveTarget, stagedFiles, workingChanges } from '../src/impact/analyze.js';
import { remember } from '../src/memory/store.js';
import { repoInfo } from '../src/project/git.js';
import { openDatabase } from '../src/store/db.js';
import { initProject } from '../src/store/project.js';
import { gitRepo, runCli } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const FILES = {
  'package.json': JSON.stringify({ name: 'root' }),
  'apps/api/package.json': JSON.stringify({ name: 'api', dependencies: { express: '5', core: '*' } }),
  'apps/api/src/server.ts': "import express from 'express';\nimport { getUser } from 'core/src/users';\nconst app = express();\napp.get('/users', (req, res) => { getUser(); });\n",
  'packages/core/package.json': JSON.stringify({ name: 'core' }),
  'packages/core/src/db.ts': "export function query() { return pool.query('SELECT * FROM users'); }\nexport function unused() {}\n",
  'packages/core/src/users.ts': "import { query } from './db';\nexport function getUser() { return query(); }\n",
  'packages/core/src/other.ts': 'export function other() {}\n',
  'packages/core/tests/users.test.ts': "import { getUser } from '../src/users';\ngetUser();\n",
  'db/schema.sql': 'CREATE TABLE users (id INT);\n',
};

async function setup(files: Record<string, string> = FILES) {
  const t = gitRepo(files);
  cleanups.push(t.cleanup);
  const { project } = initProject(repoInfo(t.dir)!);
  const db = openDatabase(t.dir);
  cleanups.push(() => db.close());
  await indexProject(project, db);
  return { t, db, project, index: GraphIndex.load(db) };
}

describe('resolving a target', () => {
  it('takes a path in any spelling, an id, or a unique name', async () => {
    const { index } = await setup();
    assert.equal(resolveTarget(index, 'packages/core/src/db.ts'), 'file:packages/core/src/db.ts');
    assert.equal(resolveTarget(index, './packages/core/src/db.ts'), 'file:packages/core/src/db.ts');
    assert.equal(resolveTarget(index, 'packages\\core\\src\\db.ts'), 'file:packages/core/src/db.ts');
    assert.equal(resolveTarget(index, 'packages/core/'), 'dir:packages/core');
    assert.equal(resolveTarget(index, 'getUser'), 'sym:packages/core/src/users.ts#function:getUser');
    assert.equal(resolveTarget(index, 'sym:packages/core/src/db.ts#function:query'), 'sym:packages/core/src/db.ts#function:query');
  });
  it('refuses to guess between same-named symbols, and explains a miss', async () => {
    const { index } = await setup({ 'a.ts': 'export function same() {}', 'b.ts': 'export function same() {}' });
    assert.throws(() => resolveTarget(index, 'same'), /matches 2 symbols/);
    assert.throws(() => resolveTarget(index, 'nope'), /Nothing in the graph/);
  });
});

describe('impact', () => {
  it('separates direct from indirect dependents', async () => {
    const { db, index } = await setup();
    const r = analyzeImpact(index, db, ['file:packages/core/src/db.ts']);
    const direct = r.direct.map((e) => e.id);
    assert.ok(direct.includes('file:packages/core/src/users.ts'));
    assert.ok(direct.includes('sym:packages/core/src/users.ts#function:getUser'));
    assert.ok(r.indirect.some((e) => e.id === 'file:apps/api/src/server.ts'));
    assert.equal([...r.direct, ...r.indirect].some((e) => e.path === 'packages/core/src/other.ts'), false);
    assert.equal([...r.direct, ...r.indirect].some((e) => e.path === 'packages/core/src/db.ts'), false, 'not its own dependent');
  });
  it('finds connected APIs, tables, tests and modules', async () => {
    const { db, index } = await setup();
    const r = analyzeImpact(index, db, ['file:packages/core/src/db.ts']);
    assert.ok(r.apis.some((e) => e.name === 'GET /users'));
    assert.deepEqual(r.tables.map((t) => [t.name, t.access]), [['users', 'reads']]);
    assert.ok(r.tests.some((t) => t.path === 'packages/core/tests/users.test.ts'));
    assert.equal(r.untested, false);
    assert.ok(r.modules.includes('core'));
    assert.ok(r.modules.includes('api'));
  });
  it('a symbol has a narrower impact than its file', async () => {
    const { db, index } = await setup();
    const file = analyzeImpact(index, db, ['file:packages/core/src/db.ts']);
    const unused = analyzeImpact(index, db, ['sym:packages/core/src/db.ts#function:unused']);
    assert.ok(file.direct.length > 0);
    assert.equal(unused.direct.length, 0);
    assert.equal(unused.untested, true);
  });
  it('flags exported symbols that others use, and no unused ones', async () => {
    const { db, index } = await setup();
    const r = analyzeImpact(index, db, ['file:packages/core/src/db.ts']);
    const q = r.breaking.find((b) => b.symbol === 'query');
    assert.ok(q && q.usedBy >= 1);
    assert.ok(q?.usedByFiles.includes('packages/core/src/users.ts'));
    assert.equal(r.breaking.some((b) => b.symbol === 'unused'), false);
  });
  it('carries uncertainty through a chain of inferred links', async () => {
    const { db, index } = await setup();
    const r = analyzeImpact(index, db, ['sym:packages/core/src/db.ts#function:query']);
    assert.ok(r.direct.some((e) => e.confidence < 1));
  });
  it('includes decisions linked to the code', async () => {
    const { db, project, index } = await setup();
    remember(db, project.config.projectId, { category: 'ARCHITECTURAL_DECISIONS', content: 'Keep raw SQL in db.ts', sourceKind: 'user', sourceRef: 'me', nodes: ['file:packages/core/src/db.ts'] });
    remember(db, project.config.projectId, { category: 'OPEN_TASKS', content: 'not a decision', sourceKind: 'user', sourceRef: 'me', nodes: ['file:packages/core/src/db.ts'] });
    const d = analyzeImpact(index, db, ['file:packages/core/src/db.ts']).decisions;
    assert.deepEqual(d.map((x) => x.content), ['Keep raw SQL in db.ts']);
    assert.equal(d[0]?.source, 'user: me');
  });
  it('respects depth, handles several targets, and survives cycles', async () => {
    const { db, index } = await setup();
    assert.equal(analyzeImpact(index, db, ['file:packages/core/src/db.ts'], { maxDepth: 1 }).indirect.length, 0);
    const both = analyzeImpact(index, db, ['file:packages/core/src/db.ts', 'file:packages/core/src/users.ts']);
    assert.equal(both.targets.length, 2);
    assert.equal([...both.direct, ...both.indirect].some((e) => e.path === 'packages/core/src/users.ts' && e.type === 'file'), false);
    const cyc = await setup({ 'a.ts': "import { b } from './b'; export function a() { b(); }", 'b.ts': "import { a } from './a'; export function b() { a(); }" });
    assert.ok(analyzeImpact(cyc.index, cyc.db, ['file:a.ts']).direct.length > 0);
  });
  it('treats a table as a target too', async () => {
    const { db, index } = await setup();
    const r = analyzeImpact(index, db, ['table:users']);
    assert.ok(r.direct.some((e) => e.name === 'query'));
    assert.ok(r.tables.some((t) => t.name === 'users' && t.access === 'defines'));
  });
});

describe('reading git', () => {
  it('parses every status, including renames', () => {
    assert.deepEqual(parseNameStatus('M\0a.ts\0A\0b.ts\0D\0c.ts\0R100\0old.ts\0new.ts\0'), [
      { path: 'a.ts', status: 'modified' }, { path: 'b.ts', status: 'added' }, { path: 'c.ts', status: 'deleted' }, { path: 'new.ts', status: 'renamed', from: 'old.ts' },
    ]);
    assert.deepEqual(parseNameStatus(''), []);
  });
  it('handles a path with spaces', () => {
    assert.deepEqual(parseNameStatus('M\0my file.ts\0'), [{ path: 'my file.ts', status: 'modified' }]);
  });
  it('sees staged, working and untracked changes separately, and never its own data', async () => {
    const { t } = await setup();
    writeFileSync(join(t.dir, 'packages/core/src/db.ts'), 'export function query() { return 2; }\n');
    writeFileSync(join(t.dir, 'new file.ts'), 'x');
    assert.deepEqual(stagedFiles(t.dir), []);
    const working = workingChanges(t.dir);
    assert.deepEqual(working.map((f) => `${f.status}:${f.path}`).sort(), ['modified:packages/core/src/db.ts', 'untracked:new file.ts']);
    t.git('add', 'packages/core/src/db.ts');
    assert.deepEqual(stagedFiles(t.dir).map((f) => f.path), ['packages/core/src/db.ts']);
  });
  it('compares ranges and branches, including renames', async () => {
    const { t } = await setup();
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'init tokenistt');
    t.git('checkout', '-q', '-b', 'feature');
    t.git('mv', 'packages/core/src/other.ts', 'packages/core/src/renamed.ts');
    writeFileSync(join(t.dir, 'added.ts'), 'x');
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'work');
    const cmp = changesAgainst(t.dir, 'main');
    assert.ok(cmp.some((f) => f.status === 'renamed' && f.path === 'packages/core/src/renamed.ts' && f.from === 'packages/core/src/other.ts'));
    assert.ok(cmp.some((f) => f.status === 'added' && f.path === 'added.ts'));
    assert.deepEqual(changesSince(t.dir, 'HEAD~1').map((f) => f.path).sort(), changesAgainst(t.dir, 'main').map((f) => f.path).sort());
  });
  it('will not pass an option-like revision to git', async () => {
    const { t } = await setup();
    assert.throws(() => changesSince(t.dir, '--output=/tmp/x'), /not a valid revision/);
    assert.throws(() => changesAgainst(t.dir, '-x'), /not a valid revision/);
  });
  it('counts how often files changed', async () => {
    const { t } = await setup();
    writeFileSync(join(t.dir, 'packages/core/src/db.ts'), 'a');
    t.git('add', 'packages/core/src/db.ts');
    t.git('commit', '-q', '-m', 'one');
    assert.equal(churn(t.dir).get('packages/core/src/db.ts'), 2);
    assert.equal(churn(t.dir).get('packages/core/src/other.ts'), 1);
    assert.equal(churn(t.dir).get('nope'), undefined);
  });
});

describe('describing changes', () => {
  it('reports dependents, tests, churn and which agent session edited a file', async () => {
    const { t, db, index } = await setup();
    handleHook('claude-code', JSON.stringify({ session_id: 'agentabcdef', hook_event_name: 'PostToolUse', cwd: t.dir, tool_name: 'Edit', tool_use_id: 'x', tool_input: { file_path: join(t.dir, 'packages/core/src/db.ts') } }));
    refresh(t.dir, db);
    const [row] = describeChanges([{ path: 'packages/core/src/db.ts', status: 'modified' }], index, db, t.dir);
    assert.ok((row?.dependents ?? 0) >= 1);
    assert.ok((row?.tests ?? 0) >= 1);
    assert.equal(row?.commitsTouching, 1);
    assert.deepEqual(row?.agentSessions, ['claude-code agentabc']);
  });
  it('says unknown rather than zero for a file not in the graph, or with no graph', async () => {
    const { db, index, t } = await setup();
    const [row] = describeChanges([{ path: 'brand-new.ts', status: 'untracked' }], index, db, t.dir);
    assert.equal(row?.dependents, null);
    assert.equal(row?.tests, null);
    assert.equal(describeChanges([{ path: 'packages/core/src/db.ts', status: 'modified' }], undefined, db, t.dir)[0]?.dependents, null);
  });
  it('flags what deserves a look, with reasons, and leaves ordinary files alone', async () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/c${i}.ts`, "import { hub } from './hub'; hub();\n"]));
    const { t, db, index } = await setup({ 'src/hub.ts': 'export function hub() {}\n', 'src/lonely.ts': 'export const x = 1;\n', 'tests/lonely.test.ts': "import { x } from '../src/lonely'; x;\n", 'notes.md': 'hi', ...many });
    const rows = describeChanges([
      { path: 'src/hub.ts', status: 'modified' }, { path: 'src/lonely.ts', status: 'modified' }, { path: 'notes.md', status: 'modified' }, { path: 'src/hub.ts', status: 'deleted' },
    ], index, db, t.dir);
    assert.ok(rows[0]?.attention.some((a) => /12 files depend on it/.test(a)));
    assert.ok(rows[0]?.attention.some((a) => /no test found/.test(a)));
    assert.deepEqual(rows[1]?.attention, [], 'small and tested');
    assert.deepEqual(rows[2]?.attention, [], 'not code');
    assert.ok(rows[3]?.attention.some((a) => /deleted, but 12 files/.test(a)));
    assert.equal(rows[3]?.attention.some((a) => /no test/.test(a)), false);
  });
});

describe('tokenistt impact and changes (end to end)', () => {
  const repo = (files: Record<string, string> = FILES) => {
    const t = gitRepo(files);
    cleanups.push(t.cleanup);
    runCli(t.dir, ['init']);
    return t;
  };
  it('impact needs a graph and a target', () => {
    const t = repo();
    assert.match(runCli(t.dir, ['impact', 'x']).err, /tokenistt map/);
    runCli(t.dir, ['map']);
    assert.equal(runCli(t.dir, ['impact']).code, 2);
    assert.equal(runCli(t.dir, ['impact', 'a', '--staged']).code, 2);
    assert.equal(runCli(t.dir, ['impact', 'getUser', '--depth', 'x']).code, 2);
    assert.equal(runCli(t.dir, ['impact', 'nope']).code, 2);
  });
  it('explains what it found, and that it is not a prediction', () => {
    const t = repo();
    runCli(t.dir, ['map']);
    const r = runCli(t.dir, ['impact', 'packages/core/src/db.ts']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /not a prediction of what will break/);
    assert.match(r.out, /Depends on it directly/);
    assert.match(r.out, /GET \/users/);
    assert.match(r.out, /users\.test\.ts/);
    assert.match(r.out, /inferred/);
    const json = JSON.parse(runCli(t.dir, ['impact', 'getUser', '--json']).out);
    assert.equal(json.targets[0].name, 'getUser');
    assert.match(runCli(t.dir, ['impact', 'packages/core/src/other.ts']).out, /No test found/);
  });
  it('--staged analyzes what is staged, and notes what the graph has not seen', () => {
    const t = repo();
    runCli(t.dir, ['map']);
    assert.match(runCli(t.dir, ['impact', '--staged']).out, /Nothing is staged/);
    writeFileSync(join(t.dir, 'packages/core/src/db.ts'), 'export function query() { return 3; }\n');
    writeFileSync(join(t.dir, 'fresh.ts'), 'x');
    t.git('add', 'packages/core/src/db.ts', 'fresh.ts');
    const r = runCli(t.dir, ['impact', '--staged']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Depends on it directly/);
    assert.match(r.err, /Not in the graph yet.*fresh\.ts/);
  });
  it('warns when the graph is older than HEAD', () => {
    const t = repo();
    runCli(t.dir, ['map']);
    writeFileSync(join(t.dir, 'x.txt'), 'x');
    t.git('add', 'x.txt');
    t.git('commit', '-q', '-m', 'later');
    assert.match(runCli(t.dir, ['impact', 'packages/core/src/db.ts']).err, /Run `tokenistt map` for current results/);
  });
  it('changes works with and without a graph, and across ranges', () => {
    const t = repo();
    writeFileSync(join(t.dir, 'packages/core/src/db.ts'), 'export function query() { return 4; }\n');
    const noGraph = runCli(t.dir, ['changes']);
    assert.equal(noGraph.code, 0, noGraph.err);
    assert.match(noGraph.out, /not yet committed/);
    assert.match(noGraph.out, /unknown/);
    assert.match(noGraph.err, /no graph yet/);
    runCli(t.dir, ['map']);
    const json = JSON.parse(runCli(t.dir, ['changes', '--json']).out);
    const db = json.files.find((f: { path: string }) => f.path === 'packages/core/src/db.ts');
    assert.ok(db.dependents >= 1);
    assert.equal(runCli(t.dir, ['changes', '--since', 'no-such-rev']).code, 2);
    assert.equal(runCli(t.dir, ['changes', '--since', 'a', '--compare', 'b']).code, 2);
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'wip');
    const since = runCli(t.dir, ['changes', '--since', 'HEAD~1']);
    assert.match(since.out, /since HEAD~1/);
    assert.match(since.out, /db\.ts/);
    t.git('checkout', '-q', '-b', 'other');
    assert.match(runCli(t.dir, ['changes', '--compare', 'main']).out, /No changes compared with main/);
  });
});
