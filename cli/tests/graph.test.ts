import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createExcluder, looksBinary } from '../src/graph/exclude.js';
import { indexProject } from '../src/graph/indexer.js';
import { extractFile } from '../src/graph/languages/index.js';
import { parseJsonc } from '../src/graph/languages/config.js';
import { isTestPath, linkGraph } from '../src/graph/linker.js';
import { readEdges, readNodes } from '../src/graph/store.js';
import type { FileExtract, GraphEdge } from '../src/graph/schema.js';
import { repoInfo } from '../src/project/git.js';
import { openDatabase } from '../src/store/db.js';
import { initProject } from '../src/store/project.js';
import { gitRepo } from './helpers.js';

const x = (path: string, text: string): Promise<FileExtract> => extractFile(path, text, 'sha', text.length);
const names = (e: FileExtract) => e.symbols.map((s) => `${s.kind}:${s.qualified}${s.exported ? '*' : ''}`).sort();

async function link(files: Record<string, string>) {
  const extracts = await Promise.all(Object.entries(files).map(([p, t]) => x(p, t)));
  return linkGraph(extracts, 'repo');
}
const has = (edges: GraphEdge[], source: string, target: string, type: string) => edges.some((e) => e.source === source && e.target === target && e.type === type);

describe('TypeScript extraction', () => {
  it('finds symbols with nesting and export flags', async () => {
    const e = await x('a.ts', `
      export function f() {}
      function g() {}
      export const h = () => 1;
      const notAFunction = 1;
      export const CONFIG = { a: 1 };
      export interface I { x: string }
      export type T = string;
      export enum E { A }
      export class C { m() {} private p = () => 1; static s() {} }
      abstract class Abs { abstract run(): void; }
      export default class D {}
    `);
    assert.deepEqual(names(e), [
      'class:Abs', 'class:C*', 'class:D*', 'function:f*', 'function:g', 'function:h*', 'interface:I*',
      'method:Abs.run', 'method:C.m', 'method:C.p', 'method:C.s', 'type:E*', 'type:T*', 'variable:CONFIG*',
    ].sort());
    assert.equal(e.defaultExport, 'D');
  });

  it('records source lines', async () => {
    const e = await x('a.ts', 'function a() {\n  return 1;\n}\n');
    assert.equal(e.symbols[0]?.startLine, 1);
    assert.equal(e.symbols[0]?.endLine, 3);
  });

  it('collects every import form with its bindings', async () => {
    const e = await x('a.ts', `
      import def, { named, other as alias } from './one';
      import * as ns from './two';
      import type { T } from './three';
      import './side-effect';
      const lazy = await import('./four');
      const cjs = require('./five');
      const { a, b: c } = require('./six');
    `);
    const by = Object.fromEntries(e.imports.map((i) => [i.source, i]));
    assert.deepEqual(by['./one']?.bindings, [{ imported: 'default', local: 'def' }, { imported: 'named', local: 'named' }, { imported: 'other', local: 'alias' }]);
    assert.deepEqual(by['./two']?.bindings, [{ imported: '*', local: 'ns' }]);
    assert.equal(by['./three']?.typeOnly, true);
    assert.ok(by['./side-effect'] && by['./four']);
    assert.deepEqual(by['./five']?.bindings, [{ imported: '*', local: 'cjs' }]);
    assert.deepEqual(by['./six']?.bindings, [{ imported: 'a', local: 'a' }, { imported: 'b', local: 'c' }]);
  });

  it('attributes calls to the enclosing symbol and reads env vars by name', async () => {
    const e = await x('a.ts', `
      function top() { helper(); obj.go(); new Thing(); return process.env.API_URL; }
      class K { run() { this.step(); return process.env['MODE']; } }
      const v = import.meta.env.VITE_X;
      const notEnv = other.env.NOPE;
    `);
    const calls = e.calls.map((c) => `${c.from}>${c.object ? `${c.object}.` : ''}${c.callee}`).sort();
    assert.deepEqual(calls, ['K.run>this.step', 'top>Thing', 'top>helper', 'top>obj.go'].sort());
    assert.deepEqual(e.env.map((v2) => v2.name).sort(), ['API_URL', 'MODE', 'VITE_X']);
  });

  it('sees heritage in TS and plain JS', async () => {
    const ts = await x('a.ts', 'class A extends B<string> implements I, J<number> {}\ninterface L extends M, N<string> {}');
    assert.deepEqual(ts.heritage.map((h) => `${h.from}:${h.kind}:${h.name}`).sort(), ['A:EXTENDS:B', 'A:IMPLEMENTS:I', 'A:IMPLEMENTS:J', 'L:EXTENDS:M', 'L:EXTENDS:N'].sort());
    const js = await x('a.js', 'class A extends B {}');
    assert.deepEqual(js.heritage.map((h) => h.name), ['B']);
  });

  it('parses TSX and flags syntax errors without losing what it could read', async () => {
    const tsx = await x('a.tsx', 'export function App() { return <div onClick={() => go()}>hi</div>; }');
    assert.deepEqual(names(tsx), ['function:App*']);
    assert.equal(tsx.parseErrors, false);
    const broken = await x('b.ts', 'export function ok() {}\nfunction ( {{{');
    assert.equal(broken.parseErrors, true);
    assert.ok(broken.symbols.some((s) => s.name === 'ok'));
  });

  it('handles CommonJS exports', async () => {
    const e = await x('a.js', 'function a() {}\nfunction b() {}\nfunction c() {}\nmodule.exports = { a, x: b };\nexports.c = c;');
    assert.deepEqual(names(e), ['function:a*', 'function:b*', 'function:c*']);
  });
});

describe('Python extraction', () => {
  it('finds symbols, imports, calls, heritage and env vars', async () => {
    const e = await x('app/m.py', `
import os
import numpy as np
from .sibling import thing as t, other
from pkg.mod import Base

class Service(Base):
    def run(self):
        self.step()
        t()
        return os.environ["TOKEN"]

def _private():
    return os.getenv("A"), os.environ.get("B")
`);
    assert.deepEqual(names(e), ['class:Service*', 'function:_private', 'method:Service.run']);
    const by = Object.fromEntries(e.imports.map((i) => [i.source, i]));
    assert.deepEqual(by['numpy']?.bindings, [{ imported: '*', local: 'np' }]);
    assert.deepEqual(by['.sibling']?.bindings, [{ imported: 'thing', local: 't' }, { imported: 'other', local: 'other' }]);
    assert.deepEqual(e.heritage.map((h) => h.name), ['Base']);
    assert.ok(e.calls.some((c) => c.object === 'this' && c.callee === 'step' && c.from === 'Service.run'));
    assert.deepEqual(e.env.map((v) => v.name).sort(), ['A', 'B', 'TOKEN']);
  });
});

describe('SQL scanner', () => {
  it('reads tables, columns, foreign keys and skips constraints', async () => {
    const e = await x('m.sql', `
      -- CREATE TABLE commented_out (a int);
      CREATE TABLE IF NOT EXISTS public.users (
        id BIGSERIAL PRIMARY KEY,
        "Email" TEXT NOT NULL CHECK (position('@' in "Email") > 0),
        org_id BIGINT REFERENCES organizations(id),
        CONSTRAINT uniq UNIQUE (id),
        FOREIGN KEY (org_id) REFERENCES billing.accounts (id)
      );
      CREATE TABLE txn_2026 PARTITION OF transactions FOR VALUES FROM ('a') TO ('b');
    `);
    const users = e.tables.find((t) => t.name === 'users');
    assert.deepEqual(users?.columns.map((c) => c.name), ['id', 'email', 'org_id']);
    assert.deepEqual(users?.references.map((r) => r.table).sort(), ['billing.accounts', 'organizations']);
    assert.equal(e.tables.some((t) => t.name === 'commented_out'), false);
    assert.equal(e.tables.find((t) => t.name === 'txn_2026')?.references[0]?.table, 'transactions');
  });
  it('reads ALTER TABLE and views, and ignores function bodies', async () => {
    const e = await x('m.sql', `
      ALTER TABLE ONLY users ADD COLUMN IF NOT EXISTS plan TEXT, ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES plans (id);
      CREATE OR REPLACE VIEW v_cost AS SELECT * FROM transactions t JOIN users u ON u.id = t.user_id;
      CREATE FUNCTION f() RETURNS void AS $$ BEGIN CREATE TABLE inside_body (a int); END; $$ LANGUAGE plpgsql;
    `);
    assert.deepEqual(e.altered[0]?.columns.map((c) => c.name), ['plan']);
    assert.deepEqual(e.altered[0]?.references.map((r) => r.table), ['plans']);
    const v = e.tables.find((t) => t.name === 'v_cost');
    assert.equal(v?.view, true);
    assert.deepEqual(v?.readsFrom.sort(), ['transactions', 'users']);
    assert.equal(e.tables.some((t) => t.name === 'inside_body'), false);
  });
});

describe('config files', () => {
  it('reads compose services and env var names, never values', async () => {
    const e = await x('docker-compose.yml', `
services:
  api:
    image: acme/api:1
    depends_on: { db: { condition: service_healthy } }
    environment:
      DATABASE_URL: postgres://user:hunter2@db/app
      TOKEN: abc123
  worker:
    depends_on: [api]
    environment:
      - SECRET=topsecret
      - PLAIN
`);
    assert.deepEqual(e.services.map((s) => s.name), ['api', 'worker']);
    assert.deepEqual(e.services[0]?.env, ['DATABASE_URL', 'TOKEN']);
    assert.deepEqual(e.services[1]?.env, ['SECRET', 'PLAIN']);
    const serialized = JSON.stringify(e);
    for (const secret of ['hunter2', 'abc123', 'topsecret']) assert.doesNotMatch(serialized, new RegExp(secret));
  });
  it('flags invalid YAML and package.json rather than throwing', async () => {
    assert.equal((await x('a.yml', 'a: [')).parseErrors, true);
    assert.equal((await x('package.json', '{ nope')).parseErrors, true);
  });
  it('parses tsconfig with comments and trailing commas, leaving strings alone', () => {
    assert.deepEqual(parseJsonc('{ // c\n "a": "http://x/*y*/", /* z */ "b": [1,], }'), { a: 'http://x/*y*/', b: [1] });
  });
  it('resolves relative Markdown links and ignores external ones', async () => {
    const e = await x('docs/guide.md', '[a](../src/a.ts) [b](https://x.dev) [c](./c.md#part) [up](../../outside.md)');
    assert.deepEqual(e.docLinks.sort(), ['docs/c.md', 'src/a.ts']);
  });
});

describe('linking', () => {
  it('resolves relative imports across .js specifiers, index files and re-exports', async () => {
    const { edges, nodes } = await link({
      'src/a.ts': "import { b } from './lib/b.js'; import { c } from './lib'; export function a() { b(); c(); nope(); }",
      'src/lib/b.ts': 'export function b() {}',
      'src/lib/c.ts': 'export function c() {}',
      'src/lib/index.ts': "export { c } from './c.js';",
    });
    assert.ok(has(edges, 'file:src/a.ts', 'file:src/lib/b.ts', 'IMPORTS'));
    assert.ok(has(edges, 'file:src/a.ts', 'file:src/lib/index.ts', 'IMPORTS'));
    assert.ok(has(edges, 'sym:src/a.ts#function:a', 'sym:src/lib/b.ts#function:b', 'CALLS'));
    assert.ok(has(edges, 'sym:src/a.ts#function:a', 'sym:src/lib/c.ts#function:c', 'CALLS'), 'follows the re-export');
    assert.equal(edges.some((e) => e.target.includes('nope')), false);
    assert.ok(nodes.every((n) => n.id));
  });

  it('counts unresolved calls instead of guessing', async () => {
    const { stats, edges } = await link({ 'a.ts': 'function a() { b(); }', 'b.ts': 'export function b() {}' });
    assert.equal(stats.callsUnresolved, 1, 'b.ts is not imported, so the same name there must not match');
    assert.equal(edges.filter((e) => e.type === 'CALLS').length, 0);
  });

  it('resolves tsconfig paths, including through extends', async () => {
    const { edges } = await link({
      'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
      'app/tsconfig.json': '{ "extends": "../tsconfig.base.json" }',
      'app/main.ts': "import { x } from '@/util';",
      'src/util.ts': 'export const x = 1;',
    });
    assert.ok(has(edges, 'file:app/main.ts', 'file:src/util.ts', 'IMPORTS'));
  });

  it('resolves workspace packages and treats the rest as external', async () => {
    const { edges, nodes } = await link({
      'packages/core/package.json': JSON.stringify({ name: '@acme/core', main: 'dist/index.js' }),
      'packages/core/src/index.ts': 'export function core() {}',
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@acme/core': '*', react: '19' } }),
      'apps/web/a.ts': "import { core } from '@acme/core'; import React from 'react'; import fs from 'fs'; import x from 'lodash/get'; core();",
    });
    assert.ok(has(edges, 'file:apps/web/a.ts', 'file:packages/core/src/index.ts', 'IMPORTS'));
    assert.ok(has(edges, 'file:apps/web/a.ts', 'sym:packages/core/src/index.ts#function:core', 'CALLS'));
    assert.ok(has(edges, 'module:apps/web', 'module:packages/core', 'DEPENDS_ON'));
    assert.ok(has(edges, 'module:apps/web', 'pkg:react', 'DEPENDS_ON'));
    assert.ok(has(edges, 'file:apps/web/a.ts', 'pkg:node:fs', 'IMPORTS'));
    assert.ok(has(edges, 'file:apps/web/a.ts', 'pkg:lodash', 'IMPORTS'));
    assert.equal(nodes.find((n) => n.id === 'pkg:react')?.metadata?.external, true);
  });

  it('resolves Python relative and absolute imports', async () => {
    const { edges } = await link({
      'pkg/__init__.py': '',
      'pkg/a.py': 'from .b import helper\nfrom pkg.c import other\nimport requests\ndef run():\n    helper()\n    other()\n',
      'pkg/b.py': 'def helper():\n    pass\n',
      'pkg/c.py': 'def other():\n    pass\n',
    });
    assert.ok(has(edges, 'file:pkg/a.py', 'file:pkg/b.py', 'IMPORTS'));
    assert.ok(has(edges, 'file:pkg/a.py', 'file:pkg/c.py', 'IMPORTS'));
    assert.ok(has(edges, 'sym:pkg/a.py#function:run', 'sym:pkg/b.py#function:helper', 'CALLS'));
    assert.ok(has(edges, 'file:pkg/a.py', 'pkg:requests', 'IMPORTS'));
  });

  it('links methods through this, namespaces and imported classes', async () => {
    const { edges } = await link({
      'a.ts': "import * as lib from './lib'; import { K } from './lib'; class Local { one() { this.two(); } two() {} } function run() { lib.f(); K.make(); }",
      'lib.ts': 'export function f() {}\nexport class K { static make() {} }',
    });
    assert.ok(has(edges, 'sym:a.ts#method:Local.one', 'sym:a.ts#method:Local.two', 'CALLS'));
    assert.ok(has(edges, 'sym:a.ts#function:run', 'sym:lib.ts#function:f', 'CALLS'));
    assert.ok(has(edges, 'sym:a.ts#function:run', 'sym:lib.ts#method:K.make', 'CALLS'));
  });

  it('links heritage, tests, env vars, tables and docs', async () => {
    const { edges, nodes } = await link({
      'src/base.ts': 'export class Base {}\nexport interface Thing {}',
      'src/impl.ts': "import { Base, Thing } from './base'; export class Impl extends Base implements Thing { x() { return process.env.KEY; } }",
      'tests/impl.test.ts': "import { Impl } from '../src/impl';",
      'db/1.sql': 'CREATE TABLE orgs (id INT);\nCREATE TABLE users (id INT, org INT REFERENCES orgs(id));',
      'db/2.sql': 'ALTER TABLE users ADD COLUMN plan TEXT;',
      'README.md': '[impl](src/impl.ts)',
    });
    assert.ok(has(edges, 'sym:src/impl.ts#class:Impl', 'sym:src/base.ts#class:Base', 'EXTENDS'));
    assert.ok(has(edges, 'sym:src/impl.ts#class:Impl', 'sym:src/base.ts#interface:Thing', 'IMPLEMENTS'));
    assert.ok(has(edges, 'test:tests/impl.test.ts', 'file:src/impl.ts', 'TESTS'));
    assert.ok(has(edges, 'sym:src/impl.ts#method:Impl.x', 'env:KEY', 'USES'));
    assert.ok(has(edges, 'table:users', 'table:orgs', 'DEPENDS_ON'));
    assert.ok(has(edges, 'file:db/2.sql', 'table:users', 'MODIFIES'));
    assert.ok(has(edges, 'table:users', 'col:users.plan', 'CONTAINS'));
    assert.ok(has(edges, 'file:src/impl.ts', 'doc:README.md', 'DOCUMENTED_BY'));
    assert.equal(nodes.find((n) => n.id === 'table:users')?.path, 'db/1.sql');
  });

  it('keeps edges unique, gives ids stable order, and leaves nothing dangling', async () => {
    const { edges, nodes } = await link({
      'a.ts': "import { b } from './b'; import { b as again } from './b'; function f() { b(); b(); again(); }",
      'b.ts': 'export function b() {}',
      'c.yml': 'services:\n  a:\n    depends_on: [elsewhere]\n',
    });
    const keys = edges.map((e) => `${e.source}|${e.target}|${e.type}`);
    assert.equal(new Set(keys).size, keys.length);
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) assert.ok(ids.has(e.source) && ids.has(e.target), `${e.source} -> ${e.target}`);
    assert.deepEqual(nodes.map((n) => n.id), [...nodes.map((n) => n.id)].sort());
  });

  it('labels name-matched edges as inferred, with lower confidence than resolved paths', async () => {
    const { edges } = await link({ 'a.ts': "import { b } from './b'; function f() { b(); }", 'b.ts': 'export function b() {}' });
    const imp = edges.find((e) => e.type === 'IMPORTS');
    const call = edges.find((e) => e.type === 'CALLS');
    assert.equal(imp?.resolution, 'resolved');
    assert.equal(imp?.confidence, 1);
    assert.equal(call?.resolution, 'import');
    assert.ok((call?.confidence ?? 1) < 1);
  });
});

describe('path rules', () => {
  it('recognises test files', () => {
    for (const p of ['a.test.ts', 'src/a.spec.js', 'tests/x.ts', 'src/__tests__/x.ts', 'test_a.py', 'pkg/a_test.go']) assert.ok(isTestPath(p), p);
    for (const p of ['src/a.ts', 'src/latest/x.ts', 'contest.py']) assert.equal(isTestPath(p), false, p);
  });
  it('excludes secrets, dependencies and build output even when tracked', () => {
    const ex = createExcluder(['private/**']);
    for (const p of ['.env', 'a/.env.production', 'certs/server.pem', 'deploy/id_rsa', 'infra/secrets.yaml', 'x/credentials.json', 'node_modules/a/b.js', 'apps/x/dist/a.js', 'a.min.js', 'tf/prod.tfstate', 'package-lock.json', 'private/notes.ts', '.tokenistt/config.json']) {
      assert.equal(ex(p), true, p);
    }
    for (const p of ['src/a.ts', 'src/env.ts', 'docs/secrets-guide.md', 'README.md', '.github/workflows/ci.yml']) assert.equal(ex(p), false, p);
  });
  it('detects binary content', () => {
    assert.equal(looksBinary(Buffer.from([1, 2, 0, 3])), true);
    assert.equal(looksBinary(Buffer.from('plain text')), false);
  });
});

describe('indexProject', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

  async function setup(files: Record<string, string>) {
    const t = gitRepo(files);
    cleanups.push(t.cleanup);
    const repo = repoInfo(t.dir)!;
    const { project } = initProject(repo);
    return { t, project };
  }

  it('builds, persists and exports a graph that matches what SQLite holds', async () => {
    const { t, project } = await setup({ 'a.ts': "import { b } from './b'; export function a() { b(); }", 'b.ts': 'export function b() {}', 'README.md': '# hi' });
    const db = openDatabase(t.dir);
    const { doc, metadata } = await indexProject(project, db);
    assert.equal(metadata.files.parsed, 3);
    assert.equal(metadata.schemaVersion, '1.0');
    assert.deepEqual(readNodes(db), doc.nodes);
    assert.deepEqual(readEdges(db), doc.edges);
    const onDisk = JSON.parse(readFileSync(join(t.dir, '.tokenistt', 'graph', 'graph.json'), 'utf8'));
    assert.equal(onDisk.schemaVersion, '1.0');
    assert.equal(onDisk.repository.name, project.config.name);
    assert.ok(existsSync(join(t.dir, '.tokenistt', 'graph', 'metadata.json')));
    const hits = db.prepare("SELECT id FROM graph_fts WHERE graph_fts MATCH 'b'").all() as Array<{ id: string }>;
    assert.ok(hits.some((h) => h.id === 'sym:b.ts#function:b'));
    db.close();
  });

  it('never reads secrets, stores no source text, and skips large and binary files', async () => {
    const { t, project } = await setup({
      '.env': 'DB_PASSWORD=hunter2',
      'src/a.ts': "const SECRET_VALUE = 'sk-live-do-not-store'; export function a() { return process.env.REAL_KEY; }",
      'big.ts': `// ${'x'.repeat(1_100_000)}\nexport function huge() {}`,
    });
    writeFileSync(join(t.dir, 'blob.dat2'), Buffer.from([0, 1, 2, 3]));
    const db = openDatabase(t.dir);
    const { doc, metadata } = await indexProject(project, db);
    const raw = readFileSync(join(t.dir, '.tokenistt', 'graph', 'graph.json'), 'utf8');
    for (const secret of ['hunter2', 'sk-live-do-not-store', 'DB_PASSWORD']) assert.doesNotMatch(raw, new RegExp(secret));
    assert.ok(doc.nodes.some((n) => n.id === 'env:REAL_KEY'));
    assert.equal(doc.nodes.some((n) => n.path === '.env'), false);
    assert.equal(doc.nodes.find((n) => n.path === 'big.ts')?.metadata?.skipped, 'too large');
    assert.equal(doc.nodes.find((n) => n.path === 'blob.dat2')?.metadata?.skipped, 'binary');
    assert.equal(doc.nodes.some((n) => n.name === 'huge'), false);
    assert.equal(metadata.files.skipped, 2);
    db.close();
  });

  it('honours configured exclusions', async () => {
    const { t, project } = await setup({ 'src/a.ts': 'export function a() {}', 'legacy/old.ts': 'export function old() {}' });
    project.config.index.exclude = ['legacy/**'];
    const db = openDatabase(t.dir);
    const { doc } = await indexProject(project, db);
    assert.equal(doc.nodes.some((n) => n.path === 'legacy/old.ts'), false);
    db.close();
  });

  it('reuses unchanged files, re-parses changed ones, and drops deleted ones', async () => {
    const { t, project } = await setup({ 'a.ts': 'export function a() {}', 'b.ts': 'export function b() {}', 'c.ts': 'export function c() {}' });
    const db = openDatabase(t.dir);
    await indexProject(project, db);
    writeFileSync(join(t.dir, 'a.ts'), 'export function renamed() {}');
    t.git('rm', '-q', 'c.ts');
    const { doc, metadata } = await indexProject(project, db);
    assert.equal(metadata.files.parsed, 1);
    assert.equal(metadata.files.reused, 1);
    assert.equal(metadata.mode, 'incremental');
    const ids = doc.nodes.map((n) => n.id);
    assert.ok(ids.includes('sym:a.ts#function:renamed'));
    assert.equal(ids.includes('sym:a.ts#function:a'), false);
    assert.equal(ids.includes('file:c.ts'), false);
    const full = await indexProject(project, db, { full: true });
    assert.equal(full.metadata.files.parsed, 2);
    assert.deepEqual(full.doc.nodes, doc.nodes, 'incremental and full agree');
    assert.deepEqual(full.doc.edges, doc.edges);
    db.close();
  });

  it('produces byte-identical graph.json on an unchanged repository', async () => {
    const { t, project } = await setup({ 'a.ts': "import { b } from './b'; b();", 'b.ts': 'export function b() {}' });
    const db = openDatabase(t.dir);
    const file = join(t.dir, '.tokenistt', 'graph', 'graph.json');
    await indexProject(project, db);
    const first = readFileSync(file, 'utf8');
    await indexProject(project, db);
    assert.equal(readFileSync(file, 'utf8'), first);
    db.close();
  });

  it('handles an empty repository', async () => {
    const { t, project } = await setup({});
    const db = openDatabase(t.dir);
    const { metadata } = await indexProject(project, db);
    assert.ok(metadata.files.total >= 0);
    db.close();
  });
});
