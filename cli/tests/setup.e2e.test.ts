import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, tempDir } from './helpers.js';

describe('tokenistt setup (end to end)', () => {
  let t: ReturnType<typeof tempDir>;
  let home: ReturnType<typeof tempDir>;
  before(() => {
    t = tempDir();
    home = tempDir();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: t.dir });
  });
  after(() => { t.cleanup(); home.cleanup(); });

  const env = () => ({ TOKENISTT_HOME: home.dir });

  it('needs a terminal or --yes, with a usage exit code and a hint', () => {
    const r = runCli(t.dir, ['setup'], { env: env() });
    assert.equal(r.code, 2);
    assert.match(r.err, /no terminal/);
    assert.match(r.err, /--yes/);
  });

  it('--yes sets up the project and connects the named agent, local-only', () => {
    const r = runCli(t.dir, ['setup', '--yes', '--agents', 'claude-code', '--no-gateway', '--json'], { env: env() });
    assert.equal(r.code, 0, r.err);
    const body = JSON.parse(r.out);
    assert.equal(body.created, true);
    assert.deepEqual(body.agents, ['claude-code']);
    assert.ok(existsSync(join(t.dir, '.tokenistt', 'config.json')));
    assert.match(readFileSync(join(t.dir, '.claude', 'settings.local.json'), 'utf8'), /hook claude-code/);
    assert.equal(body.doctor.fail, 0);
  });

  it('is safe to repeat: nothing is created or changed twice', () => {
    const before = readFileSync(join(t.dir, '.claude', 'settings.local.json'), 'utf8');
    const r = runCli(t.dir, ['setup', '--yes', '--agents', 'claude-code', '--no-gateway', '--json'], { env: env() });
    assert.equal(r.code, 0, r.err);
    const body = JSON.parse(r.out);
    assert.equal(body.created, false);
    assert.deepEqual(body.agents, ['claude-code']);
    assert.equal(readFileSync(join(t.dir, '.claude', 'settings.local.json'), 'utf8'), before);
  });

  it('rejects an unknown agent name', () => {
    const r = runCli(t.dir, ['setup', '--yes', '--agents', 'nope', '--no-gateway'], { env: env() });
    assert.notEqual(r.code, 0);
  });

  it('outside a repository --yes runs git init first', () => {
    const fresh = tempDir();
    try {
      const r = runCli(fresh.dir, ['setup', '--yes', '--agents', 'claude-code', '--no-gateway', '--json'], { env: env() });
      assert.equal(r.code, 0, r.err);
      assert.ok(existsSync(join(fresh.dir, '.git')));
    } finally { fresh.cleanup(); }
  });
});
