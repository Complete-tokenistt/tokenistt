/** Runs the real CLI as a child process against a fake gateway: argv -> exit code, stdout, stderr. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeJwt, standardGateway, tempDir } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = join(here, '..', 'src', 'main.ts');
const KEY = 'tktt_live_good_key_0123456789abcdef';

let gw: Awaited<ReturnType<typeof standardGateway>>;
let cfgDir: ReturnType<typeof tempDir>;

before(async () => { gw = await standardGateway(); cfgDir = tempDir(); });
after(async () => { await gw.close(); cfgDir.cleanup(); });

function run(args: string[], opts: { stdin?: string; env?: Record<string, string>; configDir?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TOKENISTT_CONFIG_DIR: opts.configDir ?? cfgDir.dir, NO_COLOR: '1', ...opts.env };
    const p = spawn(process.execPath, ['--import', 'tsx', MAIN, ...args], { env, cwd: join(here, '..') });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    p.stdin.end(opts.stdin ?? '');
  });
}

describe('tokenistt CLI (end to end)', () => {
  it('--version and --help exit 0', async () => {
    const v = await run(['--version']);
    assert.equal(v.code, 0);
    assert.match(v.out, /^\d+\.\d+\.\d+/);
    const h = await run(['--help']);
    assert.equal(h.code, 0);
    for (const c of ['login', 'logout', 'auth', 'connect', 'doctor']) assert.match(h.out, new RegExp(c));
  });

  it('unknown commands and missing credentials give usage (2) and auth (3) exit codes', async () => {
    assert.equal((await run(['frobnicate'])).code, 2);
    const t = tempDir();
    try {
      const s = await run(['auth', 'status'], { configDir: t.dir });
      assert.equal(s.code, 3);
      assert.match(s.out, /Not authenticated/);
      const c = await run(['connection', 'status', '--json'], { configDir: t.dir });
      assert.equal(c.code, 3);
      assert.equal(JSON.parse(c.out).state, 'not_configured');
    } finally { t.cleanup(); }
  });

  it('login reads the secret from stdin, validates it, stores it privately, and never echoes it', async () => {
    const token = fakeJwt();
    const r = await run(['login', '--token-stdin', '--api-url', gw.url], { stdin: `${token}\n` });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Logged in/);
    assert.match(r.out, /ada@example\.com/);
    assert.ok(!r.out.includes(token) && !r.err.includes(token), 'token never printed');
    const file = join(cfgDir.dir, 'config.json');
    assert.ok(existsSync(file));
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).profile.token, token);
    assert.equal(gw.requests.filter((q) => q.path === '/v1/admin/whoami').at(-1)!.headers.authorization, `Bearer ${token}`);
  });

  it('login with a bad key fails with exit 3 and stores nothing', async () => {
    const t = tempDir();
    try {
      const r = await run(['login', '--api-key-stdin', '--api-url', gw.url], { stdin: 'tktt_live_wrong_key_000000000000', configDir: t.dir });
      assert.equal(r.code, 3);
      assert.match(r.err, /rejected the credentials/);
      assert.ok(!r.err.includes('wrong_key_000000000000'), 'secret scrubbed from the error');
      assert.equal(existsSync(join(t.dir, 'config.json')), false);
    } finally { t.cleanup(); }
  });

  it('login without any credential in a non-interactive session is a usage error, not a hang', async () => {
    const r = await run(['login', '--api-url', gw.url], { configDir: tempDir().dir });
    assert.equal(r.code, 2);
    assert.match(r.err, /not interactive/);
  });

  it('auth status --json hides secrets and shows expiry', async () => {
    const r = await run(['auth', 'status', '--json']);
    assert.equal(r.code, 0);
    const s = JSON.parse(r.out);
    assert.equal(s.authenticated, true);
    assert.equal(s.credentials[0].kind, 'dashboard token');
    assert.ok(s.credentials[0].expiresAt);
    assert.ok(!r.out.includes('sig-sig-sig'));
  });

  it('auth whoami and connect work against the gateway', async () => {
    const w = await run(['auth', 'whoami', '--json']);
    assert.equal(w.code, 0, w.err);
    assert.equal(JSON.parse(w.out).organization.name, 'Acme');
    const c = await run(['connect']);
    assert.equal(c.code, 0, c.err);
    assert.match(c.out, /Connected to/);
    assert.match(c.out, /Platform/);
    assert.match(c.out, /search/);
    const s = await run(['connection', 'status', '--json']);
    assert.equal(s.code, 0);
    assert.equal(JSON.parse(s.out).state, 'connected');
    const d = await run(['disconnect']);
    assert.equal(d.code, 0);
  });

  it('environment credentials work with no login step (CI mode) and --quiet silences chatter', async () => {
    const t = tempDir();
    try {
      const r = await run(['connection', 'status', '--quiet'], { configDir: t.dir, env: { TOKENISTT_API_URL: gw.url, TOKENISTT_API_KEY: KEY } });
      assert.equal(r.code, 0, r.err);
      const d = await run(['doctor', '--json'], { configDir: t.dir, env: { TOKENISTT_API_URL: gw.url, TOKENISTT_API_KEY: KEY } });
      assert.equal(d.code, 0, d.out + d.err);
      const report = JSON.parse(d.out);
      assert.equal(report.ok, true);
      assert.equal(report.checks.find((c: any) => c.id === 'api-key').status, 'ok');
      assert.ok(!d.out.includes(KEY));
    } finally { t.cleanup(); }
  });

  it('an unreachable gateway is exit 4 (offline), with a hint', async () => {
    const t = tempDir();
    try {
      const s = await run(['connection', 'status', '--json'], { configDir: t.dir, env: { TOKENISTT_API_URL: 'http://127.0.0.1:1', TOKENISTT_API_KEY: KEY } });
      assert.equal(s.code, 4);
      assert.equal(JSON.parse(s.out).state, 'offline');
      const c = await run(['connect'], { configDir: t.dir, env: { TOKENISTT_API_URL: 'http://127.0.0.1:1', TOKENISTT_API_KEY: KEY } });
      assert.equal(c.code, 4);
      assert.match(c.err, /Could not reach/);
    } finally { t.cleanup(); }
  });

  it('errors are JSON on stderr in --json mode', async () => {
    const t = tempDir();
    try {
      const r = await run(['connect', '--json'], { configDir: t.dir, env: { TOKENISTT_API_URL: gw.url } });
      assert.equal(r.code, 3);
      assert.equal(JSON.parse(r.err).error.exit_code, 3);
    } finally { t.cleanup(); }
  });

  it('--verbose logs requests to stderr with credentials redacted', async () => {
    const r = await run(['auth', 'whoami', '--verbose']);
    assert.match(r.err, /GET \/v1\/admin\/whoami/);
    assert.ok(!r.err.includes('sig-sig-sig'));
  });

  it('logout removes the stored credentials', async () => {
    const r = await run(['logout']);
    assert.equal(r.code, 0);
    assert.equal(existsSync(join(cfgDir.dir, 'config.json')), false);
    assert.equal((await run(['auth', 'status'])).code, 3);
  });
});
