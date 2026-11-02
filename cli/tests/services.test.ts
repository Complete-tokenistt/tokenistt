import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ApiClient } from '../src/api/client.js';
import { AuthError, UsageError } from '../src/core/errors.js';
import { configFile, readProfile, resolveConfig, writeProfile } from '../src/config/store.js';
import { authStatus, describeToken, login, logout, validateLoginInput, whoami } from '../src/services/auth.js';
import { connect, connectionStatus, disconnect } from '../src/services/connection.js';
import { runDoctor } from '../src/services/doctor.js';
import { fakeJwt, standardGateway, tempDir } from './helpers.js';

const KEY = 'tktt_live_good_key_0123456789abcdef';
const noSleep = { sleep: async () => {}, baseDelayMs: 1 };
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const env = (): NodeJS.ProcessEnv => { const t = tempDir(); cleanups.push(t.cleanup); return { TOKENISTT_CONFIG_DIR: t.dir }; };
const mk = (cfg: any) => new ApiClient(cfg, noSleep);

describe('login', () => {
  it('validates input before any network call', () => {
    assert.throws(() => validateLoginInput({ apiUrl: 'gateway' }), UsageError);
    assert.throws(() => validateLoginInput({ apiUrl: 'http://x' }), /No credential/);
    assert.throws(() => validateLoginInput({ apiUrl: 'http://x', adminSecret: 's' }), /organization id/);
    assert.throws(() => validateLoginInput({ apiUrl: 'http://x', adminSecret: 's', organizationId: 'abc' }), /numeric/);
    assert.throws(() => validateLoginInput({ apiUrl: 'http://x', apiKey: 'sk-openai' }), /tktt_live_/);
  });

  it('verifies a dashboard token against the gateway, then stores it', async () => {
    const gw = await standardGateway();
    const e = env();
    try {
      const r = await login({ apiUrl: gw.url, token: fakeJwt() }, mk, e);
      assert.equal(r.identity?.actor, 'ada@example.com');
      assert.deepEqual(r.credentials, ['dashboard token']);
      assert.equal(readProfile(e)?.token !== undefined, true);
    } finally { await gw.close(); }
  });

  it('verifies an API key and reports its name', async () => {
    const gw = await standardGateway();
    const e = env();
    try {
      const r = await login({ apiUrl: gw.url, apiKey: KEY }, mk, e);
      assert.equal(r.key?.name, 'ci-key');
      assert.equal(readProfile(e)?.apiKey, KEY);
    } finally { await gw.close(); }
  });

  it('writes nothing when a credential is rejected', async () => {
    const gw = await standardGateway();
    const e = env();
    try {
      await assert.rejects(login({ apiUrl: gw.url, apiKey: 'tktt_live_wrong_key_000000000000' }, mk, e), AuthError);
      assert.equal(existsSync(configFile(e)), false);
    } finally { await gw.close(); }
  });

  it('a failed re-login does not clobber the working one', async () => {
    const gw = await standardGateway();
    const e = env();
    try {
      await login({ apiUrl: gw.url, apiKey: KEY }, mk, e);
      await assert.rejects(login({ apiUrl: gw.url, apiKey: 'tktt_live_wrong_key_000000000000' }, mk, e));
      assert.equal(readProfile(e)?.apiKey, KEY);
    } finally { await gw.close(); }
  });

  it('keeps a stored API key when a management credential is added, and swaps token for secret', async () => {
    const gw = await standardGateway();
    const e = env();
    try {
      await login({ apiUrl: gw.url, apiKey: KEY }, mk, e);
      await login({ apiUrl: gw.url, token: fakeJwt() }, mk, e);
      const p1 = readProfile(e)!;
      assert.equal(p1.apiKey, KEY);
      assert.ok(p1.token);
      await login({ apiUrl: gw.url, adminSecret: 'op', organizationId: '7' }, mk, e);
      const p2 = readProfile(e)!;
      assert.equal(p2.token, undefined, 'a token and an admin secret are not kept side by side');
      assert.equal(p2.adminSecret, 'op');
    } finally { await gw.close(); }
  });

  it('fails clearly when the gateway is down', async () => {
    const e = env();
    await assert.rejects(login({ apiUrl: 'http://127.0.0.1:1', apiKey: KEY }, mk, e), /Could not reach/);
    assert.equal(existsSync(configFile(e)), false);
  });
});

describe('auth status / whoami / logout', () => {
  it('describes tokens without verifying them', () => {
    const live = describeToken(fakeJwt(3600));
    assert.equal(live.expired, false);
    assert.equal(live.role, 'admin');
    assert.equal(describeToken(fakeJwt(-10)).expired, true);
    assert.deepEqual(describeToken('garbage'), {});
  });

  it('lists credentials masked, with their source and expiry', () => {
    const e = { ...env(), TOKENISTT_API_KEY: KEY };
    writeProfile({ apiUrl: 'http://gw.test', token: fakeJwt(-5) }, e);
    const s = authStatus(resolveConfig(e));
    assert.equal(s.authenticated, true);
    const key = s.credentials.find((c) => c.kind === 'api key')!;
    assert.equal(key.from, 'env');
    assert.ok(!JSON.stringify(s).includes(KEY), 'the key is never in the status output');
    assert.equal(s.credentials.find((c) => c.kind === 'dashboard token')!.expired, true);
  });

  it('reports not authenticated when nothing is configured', () => {
    const s = authStatus(resolveConfig(env()));
    assert.equal(s.authenticated, false);
    assert.equal(s.source, 'none');
  });

  it('whoami needs management credentials, not just a key', async () => {
    await assert.rejects(whoami(mk({ apiUrl: 'http://x', apiKey: KEY })), /only an API key/);
    const gw = await standardGateway();
    try {
      assert.equal((await whoami(mk({ apiUrl: gw.url, token: 'jwt-token-value' }))).role, 'admin');
    } finally { await gw.close(); }
  });

  it('logout removes the file', () => {
    const e = env();
    writeProfile({ apiUrl: 'http://gw.test' }, e);
    assert.deepEqual(logout(e), { removed: true });
    assert.deepEqual(logout(e), { removed: false });
  });
});

describe('connection', () => {
  it('connect discovers the organization, workspaces and projects and saves the connection', async () => {
    const gw = await standardGateway();
    const e = env();
    try {
      writeProfile({ apiUrl: gw.url, token: fakeJwt() }, e);
      const r = await connect(mk({ apiUrl: gw.url, token: fakeJwt() }), e);
      assert.equal(r.discovery?.organization.name, 'Acme');
      assert.equal(r.discovery?.workspaces.length, 1);
      assert.equal(r.discovery?.projects[0]?.slug, 'search');
      assert.equal(readProfile(e)?.connection?.organization.name, 'Acme');
      assert.deepEqual(disconnect(e), { wasConnected: true });
      assert.equal(readProfile(e)?.connection, undefined);
      assert.ok(readProfile(e)?.token, 'disconnect keeps the credentials');
      assert.deepEqual(disconnect(e), { wasConnected: false });
    } finally { await gw.close(); }
  });

  it('connect with only an API key verifies it and explains what is missing', async () => {
    const gw = await standardGateway();
    try {
      const r = await connect(mk({ apiUrl: gw.url, apiKey: KEY }), env());
      assert.equal(r.discovery, undefined);
      assert.match(r.note!, /organization discovery/);
    } finally { await gw.close(); }
  });

  it('connect without credentials is an auth error', async () => {
    await assert.rejects(connect(mk({ apiUrl: 'http://x' }), env()), AuthError);
  });

  it('status distinguishes connected, unauthorized, offline and not configured', async () => {
    const gw = await standardGateway();
    try {
      const good = mk({ apiUrl: gw.url, token: 'jwt-token-value' });
      const cfg = (c: any) => resolveConfig({ ...env(), ...c });
      assert.equal((await connectionStatus(good, cfg({}))).state, 'connected');
      assert.equal((await connectionStatus(mk({ apiUrl: gw.url, apiKey: 'tktt_live_wrong_key_000000000000' }), cfg({}))).state, 'unauthorized');
      assert.equal((await connectionStatus(mk({ apiUrl: 'http://127.0.0.1:1', apiKey: KEY }), cfg({}))).state, 'offline');
      assert.equal((await connectionStatus(mk({ apiUrl: gw.url }), cfg({}))).state, 'not_configured');
    } finally { await gw.close(); }
  });
});

describe('doctor', () => {
  it('passes on a healthy setup and gives a fix for each problem', async () => {
    const gw = await standardGateway();
    try {
      const e = env();
      const cfg = resolveConfig({ ...e, TOKENISTT_API_URL: gw.url, TOKENISTT_TOKEN: fakeJwt(), TOKENISTT_API_KEY: KEY });
      const ok = await runDoctor({ cfg, client: mk(cfg), nodeVersion: 'v22.13.0', env: e });
      assert.equal(ok.ok, true);
      assert.equal(ok.summary.fail, 0);

      const old = await runDoctor({ cfg, client: mk(cfg), nodeVersion: 'v16.0.0', env: e });
      const node = old.checks.find((c) => c.id === 'node')!;
      assert.equal(node.status, 'fail');
      assert.match(node.fix!, /Node\.js 22\.13/);

      const none = resolveConfig({ ...e, TOKENISTT_API_URL: gw.url });
      const bare = await runDoctor({ cfg: none, client: mk(none), nodeVersion: 'v22.13.0', env: e });
      assert.equal(bare.ok, false);
      assert.match(bare.checks.find((c) => c.id === 'credentials')!.fix!, /tokenistt login/);
    } finally { await gw.close(); }
  });

  it('flags an expired token and an unreachable gateway with specific advice', async () => {
    const e = env();
    const cfg = resolveConfig({ ...e, TOKENISTT_API_URL: 'http://127.0.0.1:1', TOKENISTT_TOKEN: fakeJwt(-60) });
    const r = await runDoctor({ cfg, client: mk(cfg), nodeVersion: 'v22.13.0', env: e });
    assert.match(r.checks.find((c) => c.id === 'credentials')!.detail, /expired/);
    const gw = r.checks.find((c) => c.id === 'gateway')!;
    assert.equal(gw.status, 'fail');
    assert.match(gw.detail, /Could not reach/);
  });

  it('warns when the gateway is up but its database is not', async () => {
    const gw = await (await import('./helpers.js')).fakeGateway({ 'GET /health': { json: { status: 'healthy', database: 'unreachable' } } });
    try {
      const e = env();
      const cfg = resolveConfig({ ...e, TOKENISTT_API_URL: gw.url, TOKENISTT_API_KEY: KEY });
      const r = await runDoctor({ cfg, client: mk(cfg), nodeVersion: 'v22.13.0', env: e });
      assert.equal(r.checks.find((c) => c.id === 'gateway')!.status, 'warn');
    } finally { await gw.close(); }
  });
});
