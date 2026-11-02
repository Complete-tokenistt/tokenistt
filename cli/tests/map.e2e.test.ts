import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, runCli } from './helpers.js';

describe('tokenistt map (end to end)', () => {
  let t: ReturnType<typeof gitRepo>;
  before(() => {
    t = gitRepo({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { express: '5' } }),
      'src/a.ts': "import { b } from './b.js'; export function a() { return b(); }",
      'src/b.ts': 'export function b() { return process.env.PORT; }',
      'app.py': 'def main():\n    pass\n',
      'db/schema.sql': 'CREATE TABLE users (id INT);',
    });
  });
  after(() => t.cleanup());

  it('explains itself when the project is not set up', () => {
    const r = runCli(t.dir, ['map']);
    assert.equal(r.code, 2);
    assert.match(r.err, /tokenistt init/);
  });
  it('--stats says there is no graph yet', () => {
    assert.equal(runCli(t.dir, ['init']).code, 0);
    const r = runCli(t.dir, ['map', '--stats']);
    assert.equal(r.code, 2);
    assert.match(r.err, /no graph yet/);
  });
  it('builds the graph and reports real counts as JSON', () => {
    const r = runCli(t.dir, ['map', '--json']);
    assert.equal(r.code, 0, r.err);
    const m = JSON.parse(r.out);
    assert.equal(m.files.parsed, 5);
    assert.equal(m.nodes.table, 1);
    assert.equal(m.edges.CALLS, 1);
    assert.equal(m.languages.python, 1);
    const graph = JSON.parse(readFileSync(join(t.dir, '.tokenistt', 'graph', 'graph.json'), 'utf8'));
    assert.equal(graph.nodes.filter((n: { type: string }) => n.type === 'function').length, 3);
  });
  it('second run reuses everything', () => {
    const m = JSON.parse(runCli(t.dir, ['map', '--json']).out);
    assert.equal(m.files.parsed, 0);
    assert.equal(m.files.reused, 5);
  });
  it('--full analyzes everything again', () => {
    assert.equal(JSON.parse(runCli(t.dir, ['map', '--full', '--json']).out).files.parsed, 5);
  });
  it('--export json writes split files', () => {
    const r = runCli(t.dir, ['map', '--export', 'json', '--json']);
    assert.equal(r.code, 0);
    for (const f of ['graph.json', 'nodes.json', 'edges.json']) assert.ok(existsSync(join(t.dir, '.tokenistt', 'exports', f)), f);
    assert.ok(Array.isArray(JSON.parse(readFileSync(join(t.dir, '.tokenistt', 'exports', 'edges.json'), 'utf8'))));
  });
  it('rejects an unknown export format', () => {
    assert.equal(runCli(t.dir, ['map', '--export', 'xml']).code, 2);
  });
  it('human output shows counts and honest call-resolution numbers, with no control codes when piped', () => {
    const r = runCli(t.dir, ['map', '--stats']);
    assert.equal(r.code, 0);
    assert.match(r.out, /Relationships: \d+/);
    assert.match(r.out, /never guessed/);
    assert.doesNotMatch(r.out + r.err, /\x1b/);
  });
  it('leaves the working tree clean apart from the shareable config', () => {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: t.dir, encoding: 'utf8' }).split('\n').filter(Boolean).map((l: string) => l.slice(3)).sort();
    assert.deepEqual(status, ['.tokenistt/.gitignore', '.tokenistt/config.json']);
  });
});
