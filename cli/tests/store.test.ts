import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { clearProfile, configFile, isFileTooOpen, readProfile, resolveConfig, writeProfile } from '../src/config/store.js';
import { tempDir } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const envWith = (extra: Record<string, string> = {}) => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return { TOKENISTT_CONFIG_DIR: t.dir, ...extra } as NodeJS.ProcessEnv;
};

describe('config store', () => {
  it('round-trips a profile', () => {
    const env = envWith();
    writeProfile({ apiUrl: 'http://gw.test', token: 'abc', organizationId: '7' }, env);
    assert.deepEqual(readProfile(env), { apiUrl: 'http://gw.test', token: 'abc', organizationId: '7' });
  });

  it('writes the file private (POSIX) and leaves no temp files', { skip: process.platform === 'win32' }, () => {
    const env = envWith();
    writeProfile({ apiUrl: 'http://gw.test', apiKey: 'tktt_live_x' }, env);
    assert.equal(statSync(configFile(env)).mode & 0o777, 0o600);
    assert.equal(isFileTooOpen(env), false);
  });

  it('flags a world-readable config file (POSIX)', { skip: process.platform === 'win32' }, async () => {
    const env = envWith();
    writeProfile({ apiUrl: 'http://gw.test' }, env);
    const { chmodSync } = await import('node:fs');
    chmodSync(configFile(env), 0o644);
    assert.equal(isFileTooOpen(env), true);
  });

  it('environment variables override the file and are reported as such', () => {
    const env = envWith({ TOKENISTT_TOKEN: 'from-env', TOKENISTT_API_URL: 'http://env.test/' });
    writeProfile({ apiUrl: 'http://file.test', token: 'from-file', apiKey: 'tktt_live_file' }, env);
    const cfg = resolveConfig(env);
    assert.equal(cfg.apiUrl, 'http://env.test');
    assert.equal(cfg.token, 'from-env');
    assert.equal(cfg.apiKey, 'tktt_live_file');
    assert.deepEqual(cfg.fromEnv.sort(), ['TOKENISTT_API_URL', 'TOKENISTT_TOKEN']);
  });

  it('works with no file at all (CI) and defaults to localhost', () => {
    const cfg = resolveConfig(envWith({ TOKENISTT_API_KEY: 'tktt_live_ci' }));
    assert.equal(cfg.apiKey, 'tktt_live_ci');
    assert.equal(cfg.hasFile, false);
    assert.equal(cfg.apiUrl, 'http://localhost:3000');
  });

  it('rejects a corrupt file with an actionable error', () => {
    const env = envWith();
    mkdirSync(env.TOKENISTT_CONFIG_DIR!, { recursive: true });
    writeFileSync(join(env.TOKENISTT_CONFIG_DIR!, 'config.json'), '{not json');
    assert.throws(() => readProfile(env), /unreadable or invalid/);
  });

  it('refuses to store a non-numeric organization id', () => {
    assert.throws(() => writeProfile({ apiUrl: 'http://gw.test', organizationId: 'abc' }, envWith()));
  });

  it('clearProfile removes the file and reports whether there was one', () => {
    const env = envWith();
    assert.equal(clearProfile(env), false);
    writeProfile({ apiUrl: 'http://gw.test' }, env);
    assert.equal(clearProfile(env), true);
    assert.equal(existsSync(configFile(env)), false);
  });
});
