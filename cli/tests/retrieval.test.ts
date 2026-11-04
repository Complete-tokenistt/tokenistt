import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeGraph, findCycles, traceRoute } from '../src/graph/analysis.js';
import { indexProject } from '../src/graph/indexer.js';
import { GraphIndex } from '../src/graph/query.js';
import { readEdges, readNodes } from '../src/graph/store.js';
import { extractFile } from '../src/graph/languages/index.js';
import { linkGraph } from '../src/graph/linker.js';
import type { GraphEdge } from '../src/graph/schema.js';
import { remember } from '../src/memory/store.js';
import { repoInfo } from '../src/project/git.js';
import { cosine, httpEmbedder, readEmbeddingConfig, search, updateEmbeddings, type Embed } from '../src/retrieval/engine.js';
import { openDatabase } from '../src/store/db.js';
import { initProject } from '../src/store/project.js';
import { fakeGateway, gitRepo, runCli, tempDir } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

async function linked(files: Record<string, string>) {
  return linkGraph(await Promise.all(Object.entries(files).map(([p, t]) => extractFile(p, t, 'sha', t.length))), 'repo');
}
const imp = (a: string, b: string): GraphEdge => ({ source: `file:${a}`, target: `file:${b}`, type: 'IMPORTS', confidence: 1, resolution: 'resolved' });

describe('cycles', () => {
  it('finds cycles of any length, separately, and nothing in a clean graph', () => {
    const c = findCycles([imp('a', 'b'), imp('b', 'c'), imp('c', 'a'), imp('x', 'y'), imp('y', 'x'), imp('p', 'q')]);
    assert.deepEqual(c, [['a', 'b', 'c'], ['x', 'y']]);
    assert.deepEqual(findCycles([imp('a', 'b'), imp('b', 'c'), imp('a', 'c')]), []);
  });
  it('survives a very long import chain', () => {
    const chain = Array.from({ length: 50_000 }, (_, i) => imp(`f${i}`, `f${i + 1}`));
    assert.deepEqual(findCycles(chain), []);
    assert.equal(findCycles([...chain, imp('f50000', 'f0')])[0]?.length, 50_001);
  });
});

describe('analysis', () => {
  it('reports isolated files, entry points and boundaries, and leaves tests and routes out of isolated', async () => {
    const { nodes, edges } = await linked({
      'apps/web/a.ts': "import { c } from '../../libs/core/c'; c();",
      'libs/core/c.ts': 'export function c() {}',
      'libs/core/orphan.ts': 'export const o = 1;',
      'tests/a.test.ts': 'const x = 1;',
      'apps/api/routes.ts': "import express from 'express'; const app = express(); app.get('/x', (a, b) => {});",
    });
    const a = analyzeGraph(nodes, edges);
    assert.deepEqual(a.isolated, ['libs/core/orphan.ts']);
    assert.ok(a.entryPoints.includes('apps/web/a.ts'));
    assert.deepEqual(a.boundaries, [{ from: 'apps/web', to: 'libs/core', imports: 1 }]);
  });
  it('finds highly coupled files', async () => {
    const files: Record<string, string> = { 'hub.ts': Array.from({ length: 5 }, (_, i) => `import './d${i}';`).join('\n') };
    for (let i = 0; i < 5; i++) { files[`d${i}.ts`] = 'export {};'; files[`u${i}.ts`] = "import './hub';"; }
    const { nodes, edges } = await linked(files);
    assert.deepEqual(analyzeGraph(nodes, edges).coupled, [{ path: 'hub.ts', fanIn: 5, fanOut: 5 }]);
  });
  it('lists same-name same-length functions as possible duplicates, across files only', async () => {
    const body = 'export function parse(a) {\n  a;\n  a;\n  a;\n  return a;\n}\n';
    const { nodes, edges } = await linked({ 'a.ts': body, 'b.ts': body, 'c.ts': 'export function parse(a) {\n  return a;\n}\n', 'd.ts': 'export function solo(a) {\n a;\n a;\n a;\n return a;\n}\n' });
    const d = analyzeGraph(nodes, edges).duplicates;
    assert.equal(d.length, 1);
    assert.deepEqual(d[0]?.locations, ['a.ts:1', 'b.ts:1']);
  });
  it('traces a route through its handler and calls to a table', async () => {
    const { nodes, edges } = await linked({
      's.sql': 'CREATE TABLE users (id INT);',
      'db.ts': "export function q() { return pool.query('SELECT * FROM users'); }",
      'svc.ts': "import { q } from './db'; export function load() { return q(); }",
      'api.ts': "import express from 'express'; import { load } from './svc'; const app = express(); app.get('/users', handle); function handle() { load(); }",
    });
    const ep = nodes.find((n) => n.name === 'GET /users')!;
    const t = traceRoute(ep, new Map(nodes.map((n) => [n.id, n])), edges);
    assert.deepEqual(t.steps.map((s) => s.name), ['handle', 'load', 'q']);
    assert.deepEqual(t.tables, [{ name: 'users', access: 'reads' }]);
  });
});

async function setup() {
  const t = gitRepo({ 'src/auth.ts': 'export function login() {}\nexport function logout() {}\n', 'src/use.ts': "import { login } from './auth'; login();\n", 'src/billing.ts': 'export function charge() {}\n' });
  cleanups.push(t.cleanup);
  const { project } = initProject(repoInfo(t.dir)!);
  const db = openDatabase(t.dir);
  cleanups.push(() => db.close());
  await indexProject(project, db);
  return { t, db, project, index: new GraphIndex(readNodes(db), readEdges(db)) };
}

describe('search', () => {
  it('finds code and memory together, saying which signal found each', async () => {
    const { db, index, project } = await setup();
    remember(db, project.config.projectId, { category: 'ARCHITECTURAL_DECISIONS', content: 'Login uses server sessions', sourceKind: 'user', sourceRef: 'me' });
    const { hits, semantic } = await search(db, index, 'how does login work');
    assert.equal(semantic, false);
    assert.ok(hits.some((h) => h.kind === 'code' && h.title === 'login' && h.signals.includes('name')));
    assert.ok(hits.some((h) => h.kind === 'memory' && h.signals.includes('memory')));
    assert.ok(hits.some((h) => h.signals.includes('graph')), 'callers come along');
    assert.equal(hits.some((h) => h.title === 'charge'), false);
  });
  it('works with no graph, and with nothing to find', async () => {
    const { db } = await setup();
    assert.deepEqual((await search(db, undefined, 'zzz')).hits, []);
    assert.deepEqual((await search(db, undefined, '!!!')).hits, []);
  });
  it('uses embeddings when given, reuses unchanged vectors, and sends only names and paths', async () => {
    const { db, index } = await setup();
    const seen: string[] = [];
    const embed: Embed = async (texts) => { seen.push(...texts); return texts.map((x) => (x.includes('charge') || x.includes('payments') ? [1, 0] : [0, 1])); };
    const first = await updateEmbeddings(db, index, embed, 'm');
    assert.ok(first.embedded > 0);
    assert.ok(seen.every((s) => !s.includes('export function')), 'no source code');
    assert.equal((await updateEmbeddings(db, index, embed, 'm')).embedded, 0);
    const { hits, semantic } = await search(db, index, 'payments', { embed, model: 'm' });
    assert.equal(semantic, true);
    assert.ok(hits.some((h) => h.title === 'charge' && h.signals.includes('semantic')));
  });
  it('computes cosine similarity, and survives a zero vector', () => {
    assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])), 1);
    assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
    assert.equal(cosine(new Float32Array([0, 0]), new Float32Array([1, 0])), 0);
  });
});

describe('embedding provider', () => {
  it('is off without config, reads only user config, and rejects invalid config', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const env = { TOKENISTT_CONFIG_DIR: t.dir };
    assert.equal(readEmbeddingConfig(env), undefined);
    writeFileSync(join(t.dir, 'intelligence.json'), JSON.stringify({ embeddings: { baseUrl: 'http://localhost:1/v1', model: 'x' } }));
    assert.equal(readEmbeddingConfig(env)?.model, 'x');
    writeFileSync(join(t.dir, 'intelligence.json'), '{ nope');
    assert.throws(() => readEmbeddingConfig(env), /invalid/);
  });
  it('calls an OpenAI-compatible endpoint, sends the key only if named, and orders results', async () => {
    const gw = await fakeGateway({ 'POST /v1/embeddings': () => ({ json: { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] } }) });
    try {
      const out = await httpEmbedder({ baseUrl: `${gw.url}/v1/`, model: 'm', apiKeyEnv: 'K' }, { K: 'secret' })(['a', 'b']);
      assert.deepEqual(out, [[1], [2]]);
      assert.equal(gw.requests[0]?.headers.authorization, 'Bearer secret');
      assert.deepEqual(JSON.parse(gw.requests[0]?.body ?? '{}'), { model: 'm', input: ['a', 'b'] });
      await assert.rejects(httpEmbedder({ baseUrl: `${gw.url}/v1`, model: 'm' }, {})(['a', 'b', 'c']), /unexpected response/);
      await assert.rejects(httpEmbedder({ baseUrl: `${gw.url}/nope`, model: 'm' }, {})(['a']), /HTTP 404/);
    } finally {
      await gw.close();
    }
  });
});

describe('commands (end to end)', () => {
  it('search, analyze and embeddings', () => {
    const t = gitRepo({ 'a.ts': "import './b'; export function alpha() {}\n", 'b.ts': "import './a';\n", 'server.ts': "import express from 'express'; const app = express(); app.get('/x', (q, r) => {});\n" });
    cleanups.push(t.cleanup);
    runCli(t.dir, ['init']);
    assert.equal(runCli(t.dir, ['analyze']).code, 2);
    runCli(t.dir, ['map']);
    const s = runCli(t.dir, ['search', 'alpha']);
    assert.match(s.out, /alpha/);
    assert.match(s.out, /found by name/);
    assert.match(s.out, /Semantic search is off/);
    assert.match(runCli(t.dir, ['search', 'zzzzz']).out, /Nothing found/);
    const a = runCli(t.dir, ['analyze']);
    assert.equal(a.code, 0, a.err);
    assert.match(a.out, /Circular imports \(1\)/);
    assert.match(a.out, /a\.ts <-> b\.ts/);
    assert.match(runCli(t.dir, ['analyze', '--trace', 'GET /x']).out, /GET \/x/);
    assert.equal(runCli(t.dir, ['analyze', '--trace', 'GET /nope']).code, 2);
    const e = runCli(t.dir, ['embeddings']);
    assert.equal(e.code, 2);
    assert.match(e.err, /optional/i);
  });
});
