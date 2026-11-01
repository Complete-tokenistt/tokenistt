import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchUsage, fetchRecent, GatewayError } from '../src/api';
import { usd, ago, budgetLevel, statusBarText, statusBarTooltip, requestDescription, connectionSnippet } from '../src/format';

const usage = {
  key: { name: 'my-laptop', prefix: 'tktt_live_org1_my-lap...' },
  today: { requests: 12, cost_usd: 0.4321 },
  month: { requests: 340, cost_usd: 12.5, errors: 3 },
  last_request_at: new Date(Date.now() - 90_000).toISOString(),
  budget: { cap_usd: 20, period: 'monthly' as const, spent_usd: 17, remaining_usd: 3, percent_used: 85 },
  top_models: [{ provider: 'openai', model: 'gpt-4o', requests: 100, cost_usd: 9 }],
};

let server: http.Server;
let base = '';
const seen: { url?: string; auth?: string }[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer tktt_live_good') { res.statusCode = 401; return void res.end('{}'); }
    if (req.url === '/v1/usage/me') return void res.end(JSON.stringify(usage));
    if (req.url?.startsWith('/v1/logs')) return void res.end(JSON.stringify({ data: [{ id: '1', model: 'gpt-4o', cost_usd: '0.001', status: 'success' }] }));
    res.statusCode = 500; res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

describe('gateway client', () => {
  it('fetches usage with the bearer key, tolerating /v1 and trailing slashes in the base URL', async () => {
    for (const b of [base, `${base}/`, `${base}/v1`]) {
      assert.equal((await fetchUsage(b, 'tktt_live_good')).month.requests, 340);
    }
    assert.ok(seen.every((s) => s.auth === 'Bearer tktt_live_good' && s.url === '/v1/usage/me'));
  });
  it('fetches recent requests', async () => {
    assert.equal((await fetchRecent(base, 'tktt_live_good', 5))[0].model, 'gpt-4o');
  });
  it('maps a rejected key to an auth error', async () => {
    await assert.rejects(() => fetchUsage(base, 'tktt_live_bad'), (e: GatewayError) => e.kind === 'auth');
  });
  it('maps a dead gateway to an unreachable error', async () => {
    await assert.rejects(() => fetchUsage('http://127.0.0.1:1', 'k'), (e: GatewayError) => e.kind === 'unreachable');
  });
});

describe('formatting', () => {
  it('keeps precision for tiny costs', () => {
    assert.equal(usd(0), '$0.00');
    assert.equal(usd(0.000123), '$0.0001');
    assert.equal(usd(0.4321), '$0.432');
    assert.equal(usd(12.5), '$12.50');
    assert.equal(usd(1234.5), '$1235');
  });
  it('describes relative time', () => {
    const now = Date.now();
    assert.equal(ago(null), 'never');
    assert.equal(ago(new Date(now - 30_000).toISOString(), now), '30s ago');
    assert.equal(ago(new Date(now - 7_200_000).toISOString(), now), '2h ago');
  });
  it('classifies budget level', () => {
    assert.equal(budgetLevel(usage, 80), 'warn');
    assert.equal(budgetLevel({ ...usage, budget: { ...usage.budget, percent_used: 100 } }, 80), 'critical');
    assert.equal(budgetLevel({ ...usage, budget: { ...usage.budget, percent_used: 10 } }, 80), 'ok');
    assert.equal(budgetLevel({ ...usage, budget: null }, 80), 'ok');
  });
  it('renders status bar text and tooltip', () => {
    assert.equal(statusBarText(usage), '$(pulse) $0.432 today · 85%');
    assert.equal(statusBarText({ ...usage, budget: null }), '$(pulse) $0.432 today');
    const t = statusBarTooltip(usage);
    assert.match(t, /my-laptop/);
    assert.match(t, /\$17\.00 of \$20\.00 — \$3\.00 left/);
    assert.match(t, /3 failed/);
  });
  it('flags failed requests and builds the connection snippet', () => {
    const r = { id: '1', request_id: null, provider: 'openai', model: 'gpt-4o', cost_usd: '0', prompt_tokens: 5, completion_tokens: 0, status: 'error', error_code: 'rate_limited', duration_ms: 10, created_at: new Date().toISOString() };
    assert.match(requestDescription(r), /5→0 tok · rate_limited/);
    assert.equal(connectionSnippet('http://localhost:3000/', 'tktt_x'), 'OPENAI_BASE_URL=http://localhost:3000/v1\nOPENAI_API_KEY=tktt_x');
    assert.match(connectionSnippet('http://h:3000/v1', undefined), /create one under "API keys"/);
  });
});
