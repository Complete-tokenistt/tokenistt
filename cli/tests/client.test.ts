import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient } from '../src/api/client.js';
import { ApiError, AuthError, NetworkError } from '../src/core/errors.js';
import { fakeGateway } from './helpers.js';

const noSleep = { sleep: async () => {}, baseDelayMs: 1 };
const key = 'tktt_live_ws_dev_0123456789abcdef';

describe('ApiClient', () => {
  it('sends the right credential for each mode', async () => {
    const gw = await fakeGateway({ 'GET /v1/admin/whoami': { json: {} }, 'GET /v1/usage/me': { json: {} }, 'GET /health': { json: {} } });
    try {
      const bearer = new ApiClient({ apiUrl: gw.url, token: 'jwt-token-value' }, noSleep);
      await bearer.get('management', '/v1/admin/whoami');
      const op = new ApiClient({ apiUrl: gw.url, adminSecret: 'op-secret', organizationId: '9' }, noSleep);
      await op.get('management', '/v1/admin/whoami');
      await new ApiClient({ apiUrl: gw.url, apiKey: key }, noSleep).get('key', '/v1/usage/me');
      await new ApiClient({ apiUrl: gw.url, token: 'must-not-be-sent' }, noSleep).get('none', '/health');

      assert.equal(gw.requests[0]!.headers.authorization, 'Bearer jwt-token-value');
      assert.equal(gw.requests[1]!.headers['x-admin-secret'], 'op-secret');
      assert.equal(gw.requests[1]!.headers['x-organization-id'], '9');
      assert.equal(gw.requests[2]!.headers.authorization, `Bearer ${key}`);
      assert.equal(gw.requests[3]!.headers.authorization, undefined, 'unauthenticated endpoints get no credential');
    } finally { await gw.close(); }
  });

  it('refuses to call with missing credentials, before touching the network', async () => {
    const c = new ApiClient({ apiUrl: 'http://127.0.0.1:1' }, noSleep);
    await assert.rejects(c.get('management', '/v1/admin/whoami'), AuthError);
    await assert.rejects(c.get('key', '/v1/usage/me'), AuthError);
    await assert.rejects(new ApiClient({ apiUrl: 'http://127.0.0.1:1', adminSecret: 's' }, noSleep).get('management', '/x'), /management credentials/);
  });

  it('retries GETs on 503 with backoff, then succeeds', async () => {
    let hits = 0;
    const gw = await fakeGateway({ 'GET /health': () => (++hits < 3 ? { status: 503, json: { error: { message: 'warming up' } } } : { json: { status: 'healthy' } }) });
    const waits: number[] = [];
    try {
      const c = new ApiClient({ apiUrl: gw.url }, { sleep: async (ms) => { waits.push(ms); }, baseDelayMs: 100 });
      assert.deepEqual(await c.get('none', '/health'), { status: 'healthy' });
      assert.equal(hits, 3);
      assert.equal(waits.length, 2);
      assert.ok(waits[1]! > waits[0]!, 'delay grows exponentially');
    } finally { await gw.close(); }
  });

  it('honours Retry-After on 429', async () => {
    let hits = 0;
    const gw = await fakeGateway({ 'GET /health': () => (++hits < 2 ? { status: 429, json: {}, headers: { 'retry-after': '2' } } : { json: {} }) });
    const waits: number[] = [];
    try {
      await new ApiClient({ apiUrl: gw.url }, { sleep: async (ms) => { waits.push(ms); } }).get('none', '/health');
      assert.deepEqual(waits, [2000]);
    } finally { await gw.close(); }
  });

  it('does not retry a non-idempotent POST, but does retry an idempotent one', async () => {
    let plain = 0;
    let idem = 0;
    const gw = await fakeGateway({
      'POST /v1/admin/things': () => { plain++; return { status: 503, json: {} }; },
      'POST /v1/ingest/events': () => (++idem < 3 ? { status: 503, json: {} } : { json: { accepted: 1 } }),
    });
    try {
      const c = new ApiClient({ apiUrl: gw.url, token: 'jwt-token-value', apiKey: key }, noSleep);
      await assert.rejects(c.post('management', '/v1/admin/things', { a: 1 }), ApiError);
      assert.equal(plain, 1);
      assert.deepEqual(await c.post('key', '/v1/ingest/events', { events: [] }, { idempotent: true }), { accepted: 1 });
      assert.equal(idem, 3);
    } finally { await gw.close(); }
  });

  it('does not retry client errors', async () => {
    let hits = 0;
    const gw = await fakeGateway({ 'GET /v1/admin/budgets': () => { hits++; return { status: 400, json: { error: { message: 'bad input' } } }; } });
    try {
      await assert.rejects(new ApiClient({ apiUrl: gw.url, token: 'jwt-token-value' }, noSleep).get('management', '/v1/admin/budgets'), /bad input/);
      assert.equal(hits, 1);
    } finally { await gw.close(); }
  });

  it('maps 401 / 403 / 404 to typed errors with hints', async () => {
    const gw = await fakeGateway({
      'GET /a': { status: 401, json: { error: { message: 'Invalid or expired token.' } } },
      'GET /b': { status: 403, json: { error: { message: "Role 'viewer' lacks permission 'budget:write'." } } },
      'GET /c': { status: 404, json: { error: { message: 'nope' } } },
    });
    try {
      const c = new ApiClient({ apiUrl: gw.url }, noSleep);
      await assert.rejects(c.get('none', '/a'), (e: any) => e instanceof AuthError && /login/.test(String(e.hint)));
      await assert.rejects(c.get('none', '/b'), (e: any) => e instanceof ApiError && e.status === 403 && /whoami/.test(String(e.hint)));
      await assert.rejects(c.get('none', '/c'), (e: any) => e instanceof ApiError && e.status === 404 && /older/.test(String(e.hint)));
    } finally { await gw.close(); }
  });

  it('reports an unreachable gateway as a NetworkError after retrying, without leaking credentials', async () => {
    let calls = 0;
    const failing: typeof fetch = async () => { calls++; throw new TypeError('fetch failed: connect ECONNREFUSED Bearer abcdefghijklmnop'); };
    const c = new ApiClient({ apiUrl: 'http://gw.test', token: 'jwt-token-value' }, { fetch: failing, ...noSleep });
    await assert.rejects(c.get('none', '/health'), (e: any) => {
      assert.ok(e instanceof NetworkError);
      assert.ok(!e.message.includes('abcdefghijklmnop'), 'credential scrubbed from message');
      assert.match(e.message, /http:\/\/gw\.test/);
      return true;
    });
    assert.equal(calls, 4);
  });

  it('times out a hung gateway', async () => {
    // A real hung request holds a socket open; the fake needs a ref'd handle to keep the loop alive the same way
    // (AbortSignal.timeout's own timer is unref'd, and Node 20 would otherwise exit with the promise pending).
    const hang: typeof fetch = (_u, init) => new Promise((_res, rej) => {
      const keepAlive = setInterval(() => {}, 1000);
      init!.signal!.addEventListener('abort', () => { clearInterval(keepAlive); rej(new Error('aborted by timeout')); });
    });
    const c = new ApiClient({ apiUrl: 'http://gw.test' }, { fetch: hang, timeoutMs: 20, maxAttempts: 1 });
    await assert.rejects(c.get('none', '/health'), NetworkError);
  });

  it('explains a non-JSON answer (wrong URL, e.g. the dashboard)', async () => {
    const gw = await fakeGateway({ 'GET /health': { text: '<html>hi</html>' } as any });
    try {
      await assert.rejects(new ApiClient({ apiUrl: gw.url }, noSleep).get('none', '/health'), /non-JSON/);
    } finally { await gw.close(); }
  });
});
