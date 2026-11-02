import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrateGraphDocument, parseGraphDocument } from '../src/graph/export.js';
import { watchFiles } from '../src/graph/watch.js';
import { gitRepo, runCli, tempDir } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const valid = () => ({
  schemaVersion: '1.0',
  repository: { id: 'repo_0123456789abcdef', name: 'x', branch: 'main', commit: null },
  nodes: [{ id: 'file:a.ts', type: 'file', name: 'a.ts' }, { id: 'file:b.ts', type: 'file', name: 'b.ts' }],
  edges: [{ source: 'file:a.ts', target: 'file:b.ts', type: 'IMPORTS', confidence: 1, resolution: 'resolved' }],
});

describe('graph import validation', () => {
  it('accepts a valid document', () => assert.equal(parseGraphDocument(JSON.stringify(valid())).nodes.length, 2));
  it('rejects bad JSON, wrong shape, duplicates and dangling edges', () => {
    assert.throws(() => parseGraphDocument('{'), /not valid JSON/);
    assert.throws(() => parseGraphDocument('[]'), /schemaVersion/);
    assert.throws(() => parseGraphDocument(JSON.stringify({ ...valid(), nodes: 'x' })), /invalid at nodes/);
    assert.throws(() => parseGraphDocument(JSON.stringify({ ...valid(), nodes: [...valid().nodes, valid().nodes[0]] })), /duplicate/);
    assert.throws(() => parseGraphDocument(JSON.stringify({ ...valid(), edges: [{ ...valid().edges[0], target: 'file:ghost' }] })), /missing node/);
    assert.throws(() => parseGraphDocument(JSON.stringify({ ...valid(), edges: [{ ...valid().edges[0], confidence: 7 }] })), /invalid/);
  });
  it('refuses a newer schema and explains an unknown old one', () => {
    assert.throws(() => parseGraphDocument(JSON.stringify({ ...valid(), schemaVersion: '9.0' })), /newer than this CLI/);
    assert.throws(() => parseGraphDocument(JSON.stringify({ ...valid(), schemaVersion: '0.1' })), /No migration/);
  });
  it('compares versions numerically', () => {
    assert.throws(() => migrateGraphDocument({ schemaVersion: '1.10' }, {}, '1.9'), /newer than this CLI/);
  });
  it('walks migrations in order', () => {
    const steps = {
      '0.8': (d: Record<string, unknown>) => ({ ...d, schemaVersion: '0.9', a: 1 }),
      '0.9': (d: Record<string, unknown>) => ({ ...d, schemaVersion: '1.0', b: 2 }),
    };
    assert.deepEqual(migrateGraphDocument({ schemaVersion: '0.8' }, steps, '1.0'), { schemaVersion: '1.0', a: 1, b: 2 });
  });
});

describe('tokenistt map modes (end to end)', () => {
  it('--incremental needs an existing graph, and rejects --full', () => {
    const t = gitRepo({ 'a.ts': 'export function a() {}' });
    cleanups.push(t.cleanup);
    runCli(t.dir, ['init']);
    const none = runCli(t.dir, ['map', '--incremental']);
    assert.equal(none.code, 2);
    assert.match(none.err, /no graph to update/);
    assert.equal(runCli(t.dir, ['map', '--full', '--incremental']).code, 2);
    assert.equal(runCli(t.dir, ['map']).code, 0);
    const again = JSON.parse(runCli(t.dir, ['map', '--incremental', '--json']).out);
    assert.equal(again.files.reused, 1);
  });

  it('exports from one repo and imports into another, and the next map replaces it', () => {
    const a = gitRepo({ 'a.ts': "import { b } from './b'; b();", 'b.ts': 'export function b() {}' });
    const b = gitRepo({ 'other.ts': 'export function other() {}' });
    cleanups.push(a.cleanup, b.cleanup);
    runCli(a.dir, ['init']);
    runCli(b.dir, ['init']);
    assert.equal(runCli(a.dir, ['map']).code, 0);
    const exported = join(a.dir, '.tokenistt', 'graph', 'graph.json');
    const original = JSON.parse(readFileSync(exported, 'utf8'));

    const imported = runCli(b.dir, ['map', '--import', exported, '--json']);
    assert.equal(imported.code, 0, imported.err);
    assert.equal(JSON.parse(imported.out).mode, 'imported');
    const stored = JSON.parse(readFileSync(join(b.dir, '.tokenistt', 'graph', 'graph.json'), 'utf8'));
    assert.deepEqual(stored.nodes, original.nodes);
    assert.deepEqual(stored.edges, original.edges);
    assert.equal(JSON.parse(runCli(b.dir, ['map', '--stats', '--json']).out).mode, 'imported');

    const rebuilt = JSON.parse(runCli(b.dir, ['map', '--json']).out);
    assert.equal(rebuilt.files.parsed, 1, 'the import dropped the cache, so nothing is reused');
    assert.ok(JSON.parse(readFileSync(join(b.dir, '.tokenistt', 'graph', 'graph.json'), 'utf8')).nodes.some((n: { id: string }) => n.id === 'file:other.ts'));
  });

  it('rejects an invalid import and leaves the graph alone', () => {
    const t = gitRepo({ 'a.ts': 'export function a() {}' });
    cleanups.push(t.cleanup);
    runCli(t.dir, ['init']);
    runCli(t.dir, ['map']);
    const bad = join(t.dir, 'bad.json');
    writeFileSync(bad, '{"schemaVersion":"1.0"}');
    const r = runCli(t.dir, ['map', '--import', bad]);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(runCli(t.dir, ['map', '--stats', '--json']).out).nodes.file, 1);
    assert.equal(runCli(t.dir, ['map', '--import', join(t.dir, 'nope.json')]).code, 2);
  });
});

describe('watchFiles', () => {
  const until = async (cond: () => boolean, ms = 15000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    assert.ok(cond(), 'timed out');
  };

  it('debounces bursts, skips excluded paths, and never overlaps runs', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const batches: string[][] = [];
    let active = 0;
    let maxActive = 0;
    const h = watchFiles({
      root: t.dir,
      debounceMs: 80,
      onChange: async (changed) => {
        active++;
        maxActive = Math.max(maxActive, active);
        batches.push(changed);
        await new Promise((r) => setTimeout(r, 200));
        active--;
      },
    });
    try {
      await new Promise((r) => setTimeout(r, 150));
      for (let i = 0; i < 5; i++) writeFileSync(join(t.dir, 'a.ts'), `// ${i}`);
      writeFileSync(join(t.dir, '.env'), 'SECRET=1');
      await until(() => batches.length >= 1);
      assert.ok(batches[0]?.includes('a.ts'));
      assert.equal(batches.flat().includes('.env'), false);

      // A change during a run is picked up by a follow-up run, not lost.
      writeFileSync(join(t.dir, 'b.ts'), '1');
      await new Promise((r) => setTimeout(r, 100));
      writeFileSync(join(t.dir, 'c.ts'), '2');
      await until(() => batches.flat().includes('c.ts') && batches.flat().includes('b.ts'));
      assert.equal(maxActive, 1);
    } finally {
      h.close();
      await h.idle();
    }
  });

  it('reports errors from a run and keeps watching', async () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const errors: unknown[] = [];
    let calls = 0;
    const h = watchFiles({
      root: t.dir,
      debounceMs: 30,
      onChange: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
      },
      onError: (e) => errors.push(e),
    });
    try {
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(join(t.dir, 'a.ts'), '1');
      await until(() => errors.length === 1);
      writeFileSync(join(t.dir, 'a.ts'), '2');
      await until(() => calls >= 2);
    } finally {
      h.close();
      await h.idle();
    }
  });
});
