import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { extractFile } from '../src/graph/languages/index.js';
import { linkGraph } from '../src/graph/linker.js';
import { DEFAULT_ASSETS, startViewer, type ViewerHandle } from '../src/viewer/server.js';
import { GraphIndex } from '../src/graph/query.js';
import { gitRepo, runCli, tempDir } from './helpers.js';

async function index(files: Record<string, string>): Promise<GraphIndex> {
  const extracts = await Promise.all(Object.entries(files).map(([p, t]) => extractFile(p, t, 'sha', t.length)));
  const { nodes, edges } = linkGraph(extracts, 'repo');
  return new GraphIndex(nodes, edges);
}

const FILES = {
  'src/lib/db.ts': 'export function query() {}\n',
  'src/lib/users.ts': "import { query } from './db';\nexport function getUser() { query(); return process.env.TOKEN; }\n",
  'src/api.ts': "import { getUser } from './lib/users';\nexport function handler() { getUser(); }\n",
  'src/other.ts': 'export function isolated() {}\n',
  'tests/users.test.ts': "import { getUser } from '../src/lib/users';\ngetUser();\n",
  'db/schema.sql': 'CREATE TABLE users (id INT);\n',
};

describe('GraphIndex', () => {
  it('builds one display tree, with synthetic groups for things not on disk', async () => {
    const g = await index(FILES);
    const top = g.childrenOf('dir:.').items.map((v) => v.id);
    assert.ok(top.includes('dir:src') && top.includes('group:tables') && top.includes('group:env'));
    assert.deepEqual(g.childrenOf('group:tables').items.map((v) => v.id), ['table:users']);
    assert.equal(top.includes('group:root-files'), false, 'no loose files in this fixture');
    assert.deepEqual(g.ancestors('sym:src/lib/db.ts#function:query'), ['dir:.', 'dir:src', 'dir:src/lib', 'file:src/lib/db.ts']);
    assert.ok((g.view('dir:src')?.descendants ?? 0) >= 8);
  });

  it('collects loose top-level files into one group', async () => {
    const g = await index({ 'README.md': '# x', 'LICENSE': 'x', 'src/a.ts': 'export const a = 1;' });
    const top = g.childrenOf('dir:.').items.map((v) => v.id);
    assert.deepEqual(top.sort(), ['dir:src', 'group:root-files']);
    assert.deepEqual(g.ancestors('file:README.md'), ['dir:.', 'group:root-files']);
  });

  it('rolls edges up to what is visible, merging and counting them', async () => {
    const g = await index(FILES);
    const edges = g.rollup(new Set(['dir:src', 'dir:tests', 'group:env']));
    const srcEnv = edges.find((e) => e.source === 'dir:src' && e.target === 'group:env');
    assert.equal(srcEnv?.types.USES, 1);
    const tests = edges.find((e) => e.source === 'dir:tests' && e.target === 'dir:src');
    assert.ok(tests && tests.count >= 3);
    assert.equal(edges.some((e) => e.source === e.target), false, 'internal edges disappear');
    assert.equal(edges.some((e) => e.types.CONTAINS), false);
  });

  it('marks a rolled edge exact only if every underlying edge was', async () => {
    const g = await index(FILES);
    const imports = g.rollup(new Set(['file:src/api.ts', 'file:src/lib/users.ts']), new Set(['IMPORTS']))[0];
    assert.equal(imports?.exact, true);
    const mixed = g.rollup(new Set(['file:src/api.ts', 'file:src/lib/users.ts']))[0];
    assert.equal(mixed?.exact, false);
  });

  it('filters rolled edges by type', async () => {
    const g = await index(FILES);
    const edges = g.rollup(new Set(['file:src/api.ts', 'file:src/lib/users.ts', 'file:src/lib/db.ts']), new Set(['IMPORTS']));
    assert.ok(edges.length > 0 && edges.every((e) => Object.keys(e.types).join() === 'IMPORTS'));
  });

  it('traverses both directions with depth, and treats a file as its contents', async () => {
    const g = await index(FILES);
    const dependents = g.traverse('file:src/lib/db.ts', 'dependents');
    const at = (id: string) => dependents.find((d) => d.id === id)?.depth;
    assert.equal(at('file:src/lib/users.ts'), 1);
    assert.equal(at('sym:src/lib/users.ts#function:getUser'), 1);
    assert.equal(at('sym:src/api.ts#function:handler'), 2);
    assert.equal(dependents.some((d) => d.id === 'file:src/other.ts'), false);
    const deps = g.traverse('sym:src/api.ts#function:handler', 'dependencies');
    assert.ok(deps.some((d) => d.id === 'sym:src/lib/db.ts#function:query'));
    assert.ok(deps.some((d) => d.id === 'env:TOKEN'));
  });

  it('respects depth and limit, carries the weakest confidence, and survives cycles', async () => {
    const g = await index({ 'a.ts': "import { b } from './b'; export function a() { b(); }", 'b.ts': "import { a } from './a'; export function b() { a(); }", 'c.ts': "import { a } from './a'; a();" });
    assert.ok(g.traverse('file:a.ts', 'dependents').length > 0);
    assert.equal(g.traverse('file:a.ts', 'dependents', { maxDepth: 1 }).every((d) => d.depth === 1), true);
    assert.equal(g.traverse('file:a.ts', 'dependents', { limit: 1 }).length, 1);
    const viaCall = g.traverse('sym:a.ts#function:a', 'dependents', { types: ['CALLS'] });
    assert.ok(viaCall.every((d) => d.confidence < 1));
  });

  it('searches names first, then paths', async () => {
    const g = await index(FILES);
    assert.equal(g.search('getUser')[0]?.id, 'sym:src/lib/users.ts#function:getUser');
    assert.ok(g.search('lib/db').some((v) => v.id === 'file:src/lib/db.ts'));
    assert.deepEqual(g.search('   '), []);
    assert.deepEqual(g.search('zzz-nothing'), []);
  });

  it('lists direct relations and most-depended-on nodes', async () => {
    const g = await index(FILES);
    const r = g.relations('sym:src/lib/users.ts#function:getUser');
    assert.ok(r.incoming.some((x) => x.name === 'handler' && x.edge === 'CALLS'));
    assert.ok(r.outgoing.some((x) => x.id === 'env:TOKEN'));
    assert.ok(g.mostUsed().length > 0);
    assert.equal(g.mostUsed().some((v) => v.type === 'package' || v.type === 'directory'), false);
  });
});

describe('viewer server', () => {
  let v: ViewerHandle;
  let t: ReturnType<typeof gitRepo>;
  let assets: ReturnType<typeof tempDir>;

  const call = (path: string, opts: { method?: string; token?: string | null; host?: string; body?: string } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${v.port}` };
      const token = opts.token === undefined ? v.token : opts.token;
      if (token) headers['x-tokenistt-token'] = token;
      const req = http.request({ host: '127.0.0.1', port: v.port, path, method: opts.method ?? 'GET', headers }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      });
      req.on('error', reject);
      req.end(opts.body);
    });

  before(async () => {
    t = gitRepo(FILES);
    assets = tempDir();
    for (const f of ['index.html', 'app.js', 'style.css']) writeFileSync(join(assets.dir, f), `/* ${f} */`);
    v = await startViewer({ index: await index(FILES), root: t.dir, assetsDir: assets.dir });
  });
  after(async () => {
    await v.close();
    t.cleanup();
    assets.cleanup();
  });

  it('only listens on loopback, on a URL carrying the token', () => {
    assert.match(v.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    assert.ok(v.token.length >= 30);
  });
  it('requires the token for every data route', async () => {
    for (const path of ['/api/overview', '/api/search?q=a', '/api/node?id=file:src/api.ts', '/api/recent']) {
      assert.equal((await call(path, { token: null })).status, 401, path);
      assert.equal((await call(path, { token: 'wrong' })).status, 401, path);
    }
  });
  it('refuses a foreign Host header, which stops DNS rebinding', async () => {
    assert.equal((await call('/api/overview', { host: 'evil.example.com' })).status, 403);
    assert.equal((await call('/', { host: `evil.example.com:${v.port}` })).status, 403);
    assert.equal((await call('/api/overview', { host: `localhost:${v.port}` })).status, 200);
  });
  it('is read-only and sends a restrictive policy', async () => {
    assert.equal((await call('/api/overview', { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await call('/api/node?id=x', { method: 'DELETE' })).status, 405);
    assert.equal((await call('/', { method: 'POST' })).status, 405);
    const page = await call('/');
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
    assert.match(String(page.headers['content-security-policy']), /connect-src 'self'/);
  });
  it('serves only its own assets', async () => {
    assert.equal((await call('/app.js')).status, 200);
    for (const path of ['/../package.json', '/..%2f..%2fpackage.json', '/config.json', '/.env']) assert.equal((await call(path)).status, 404, path);
  });
  it('answers overview, children, search, node, impact and recent', async () => {
    const overview = JSON.parse((await call('/api/overview')).text);
    assert.ok(overview.children.items.length > 0);
    assert.ok(JSON.parse((await call('/api/children?id=dir%3Asrc')).text).items.some((c: { id: string }) => c.id === 'file:src/api.ts'));
    assert.ok(JSON.parse((await call('/api/search?q=getUser')).text).items.length > 0);
    const node = JSON.parse((await call(`/api/node?id=${encodeURIComponent('file:src/api.ts')}`)).text);
    assert.equal(node.history[0].subject, 'first');
    assert.equal((await call('/api/node?id=nope')).status, 404);
    assert.ok(JSON.parse((await call(`/api/impact?id=${encodeURIComponent('file:src/lib/db.ts')}`)).text).items.length > 0);
    assert.ok(JSON.parse((await call('/api/recent')).text).items.some((c: { path: string }) => c.path === 'src/api.ts'));
    assert.ok(JSON.parse((await call(`/api/ancestors?id=${encodeURIComponent('file:src/api.ts')}`)).text).ids.includes('dir:src'));
  });
  it('explains a port that is already in use', async () => {
    await assert.rejects(startViewer({ index: await index(FILES), root: t.dir, assetsDir: assets.dir, port: v.port }), /already in use/);
  });
  it('rolls up a subgraph and rejects bad input', async () => {
    const ok = await call('/api/subgraph', { method: 'POST', body: JSON.stringify({ visible: ['dir:src', 'dir:tests'] }) });
    assert.ok(JSON.parse(ok.text).edges.length > 0);
    assert.equal((await call('/api/subgraph', { method: 'POST', body: '{' })).status, 400);
    assert.equal((await call('/api/subgraph', { method: 'POST', body: '{"visible":"x"}' })).status, 400);
  });
  it('does not pass user input to git as an option', async () => {
    assert.equal((await call(`/api/node?id=${encodeURIComponent('file:--output=/tmp/x')}`)).status, 404);
  });
});

describe('tokenistt graph (end to end)', () => {
  it('prints a summary, and explains when there is no graph', () => {
    const t = gitRepo(FILES);
    try {
      runCli(t.dir, ['init']);
      const none = runCli(t.dir, ['graph']);
      assert.equal(none.code, 2);
      assert.match(none.err, /tokenistt map/);
      runCli(t.dir, ['map']);
      const r = runCli(t.dir, ['graph']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Largest areas/);
      assert.match(r.out, /Most depended on/);
      const json = JSON.parse(runCli(t.dir, ['graph', '--json']).out);
      assert.ok(json.top.length > 0);
      assert.equal(runCli(t.dir, ['graph', '--open', '--port', 'nope']).code, 2);
    } finally {
      t.cleanup();
    }
  });
  it('the built bundle needs nothing from the network, when it has been built', async (ctx) => {
    if (!existsSync(join(DEFAULT_ASSETS, 'app.js'))) return ctx.skip('run npm run build -w cli');
    const html = readFileSync(join(DEFAULT_ASSETS, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /https?:\/\//);
  });
});
