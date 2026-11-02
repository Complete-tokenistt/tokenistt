import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempDir } from './helpers.js';

describe('tokenistt init (end to end)', () => {
  let t: ReturnType<typeof tempDir>;
  before(() => {
    t = tempDir();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: t.dir });
    writeFileSync(join(t.dir, 'a.ts'), 'export const a = 1;\n');
  });
  after(() => t.cleanup());

  it('creates the project, reports JSON on stdout, and stays quiet about SQLite', () => {
    const r = runCli(t.dir, ['init', '--json']);
    assert.equal(r.code, 0, r.err);
    const body = JSON.parse(r.out);
    assert.equal(body.created, true);
    assert.equal(body.languages[0].language, 'typescript');
    assert.ok(existsSync(join(t.dir, '.tokenistt', 'database', 'local.db')));
    assert.doesNotMatch(r.err, /ExperimentalWarning|SQLite/);
  });
  it('is idempotent', () => {
    const r = runCli(t.dir, ['init', '--json']);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).created, false);
  });
  it('prints stage lines without control codes when not a terminal', () => {
    const r = runCli(t.dir, ['init']);
    assert.equal(r.code, 0);
    assert.match(r.err, /✔ Detecting Git repository/);
    assert.doesNotMatch(r.err, /\x1b/);
  });
  it('doctor reports the project and local database', () => {
    const r = runCli(t.dir, ['doctor', '--json'], { env: { TOKENISTT_API_URL: 'http://127.0.0.1:9' } });
    const checks = JSON.parse(r.out).checks as Array<{ id: string; status: string }>;
    assert.equal(checks.find((c) => c.id === 'project')?.status, 'ok');
    assert.equal(checks.find((c) => c.id === 'local-db')?.status, 'ok');
  });
  it('fails with the usage exit code outside a repository', () => {
    const outside = tempDir();
    const r = runCli(outside.dir, ['init']);
    outside.cleanup();
    assert.equal(r.code, 2);
    assert.match(r.err, /not inside a Git repository/);
  });
});
