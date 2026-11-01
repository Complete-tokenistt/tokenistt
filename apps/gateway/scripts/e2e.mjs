#!/usr/bin/env node
/**
 * End-to-end check of the running gateway (no real providers needed).
 *
 *   DATABASE_URL=postgres://tokenistt:tokenistt@localhost:5433/tokenistt \
 *   REDIS_URL=redis://localhost:6380 npm run test:e2e -w apps/gateway
 *
 * Boots the server with MOCK_PROVIDER=1, then drives it over HTTP: key creation, billing,
 * request history, response cache, approval policy, routing + failover, BYOK key failover,
 * budget enforcement, attribution, batch, OpenAPI and the audit trail.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = process.env.E2E_PORT || '3555';
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_SECRET = 'e2e-admin-secret-0123456789abcdef0123456789';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }

const env = {
  ...process.env,
  PORT, MOCK_PROVIDER: '1', DEFAULT_PROVIDER: 'mock', ADMIN_SECRET,
  MASTER_KEY: 'e2e-master-key-0123456789abcdef0123456789abcdef',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6380',
  TX_QUEUE_FILE: join(root, `e2e_queue_${PORT}.jsonl`), AUDIT_QUEUE_FILE: join(root, `e2e_audit_${PORT}.jsonl`),
  NODE_ENV: 'development',
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${ok ? '' : `  → ${detail}`}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => (serverLog += d));
server.stderr.on('data', d => (serverLog += d));

const pool = new pg.Pool({ connectionString: DATABASE_URL });
let orgId;

async function admin(method, path, body, query = '') {
  const sep = path.includes('?') || query ? '&' : '?';
  const r = await fetch(`${BASE}/v1/admin${path}${query}${sep}organization_id=${orgId}`, {
    method, headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN_SECRET }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
}
async function chat(token, body, headers = {}) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body),
  });
  let json; try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json, headers: r.headers };
}
const msg = content => [{ role: 'user', content }];

async function waitHealthy() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* starting */ }
    if (server.exitCode !== null) return false;
    await sleep(250);
  }
  return false;
}

async function main() {
  console.log('Booting gateway…');
  if (!(await waitHealthy())) { console.error(serverLog.slice(-2000)); throw new Error('gateway did not become healthy'); }

  const sfx = randomUUID().slice(0, 8);
  orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`E2E ${sfx}`, `e2e-${sfx}`])).rows[0].id;
  const ws = (await pool.query(`INSERT INTO workspaces (organization_id, name, cost_center) VALUES ($1,'E2E','CC-E2E') RETURNING id::text`, [orgId])).rows[0].id;

  console.log('\nKeys & billing');
  const keyRes = await admin('POST', '/keys', { name: 'e2e-key', workspace_id: ws, budgetCapUsd: 50 });
  check('POST /v1/admin/keys returns a one-time token', keyRes.status === 201 && /^tktt_live_/.test(keyRes.json?.token ?? ''), keyRes.text);
  const token = keyRes.json.token;
  const vkInternal = (await pool.query(`SELECT id::text FROM virtual_keys WHERE public_id::text = $1`, [keyRes.json.id])).rows[0].id;

  const bad = await chat('tktt_live_wrong_wrong_wrong', { model: 'mock:echo', messages: msg('x') });
  check('invalid key is rejected with 401', bad.status === 401, `status ${bad.status}`);

  const ok = await chat(token, { model: 'mock:echo', messages: msg('hello e2e') }, { 'x-tokenistt-feature': 'search', 'x-tokenistt-repo': 'acme/api' });
  check('chat completion succeeds through the pipeline', ok.status === 200 && ok.json?.choices?.[0]?.message?.content?.includes('hello e2e'), JSON.stringify(ok.json)?.slice(0, 200));
  check('cost headers present and > 0', Number(ok.headers.get('x-tokenistt-cost')) > 0, ok.headers.get('x-tokenistt-cost'));
  await sleep(500);
  const row = (await pool.query(`SELECT cost_usd::float AS c, provider, feature, repo FROM transactions WHERE organization_id = $1 ORDER BY id DESC LIMIT 1`, [orgId])).rows[0];
  check('transaction logged with cost + attribution', row && row.c > 0 && row.feature === 'search' && row.repo === 'acme/api', JSON.stringify(row));

  const logs = await (await fetch(`${BASE}/v1/logs?limit=5`, { headers: { authorization: `Bearer ${token}` } })).json();
  check('GET /v1/logs returns the key’s history', logs.data?.length >= 1 && logs.data[0].model === 'echo' || logs.data?.[0]?.model?.includes('echo'), JSON.stringify(logs).slice(0, 200));

  console.log('\nCache, batch, docs');
  const q = { model: 'mock:echo', temperature: 0, messages: msg('cache me') };
  const c1 = await chat(token, q, { 'x-tokenistt-cache': 'true' });
  const c2 = await chat(token, q, { 'x-tokenistt-cache': 'true' });
  check('response cache: MISS then HIT at zero cost', c1.headers.get('x-tokenistt-cache') === 'MISS' && c2.headers.get('x-tokenistt-cache') === 'HIT' && c2.headers.get('x-tokenistt-cost') === '0.000000',
    `${c1.headers.get('x-tokenistt-cache')}/${c2.headers.get('x-tokenistt-cache')}`);
  const batch = await (await fetch(`${BASE}/v1/batch/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ requests: [{ model: 'mock:echo', messages: msg('b1') }, { model: 'mock:echo', messages: msg('b2') }] }),
  })).json();
  check('batch endpoint runs each item through the pipeline', batch.results?.length === 2 && batch.results.every(r => r.status === 200), JSON.stringify(batch).slice(0, 200));
  const spec = await (await fetch(`${BASE}/v1/openapi.json`)).json();
  check('OpenAPI document is served', spec.openapi === '3.1.0' && !!spec.paths['/v1/chat/completions']);

  console.log('\nStreaming');
  async function stream(body) {
    const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ ...body, stream: true }) });
    const raw = await r.text();
    const events = raw.split('\n\n').filter(Boolean);
    const chunks = events.filter(e => e !== 'data: [DONE]').map(e => JSON.parse(e.slice(6)));
    return { status: r.status, type: r.headers.get('content-type'), done: events.at(-1) === 'data: [DONE]', text: chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join('') };
  }
  const st = await stream({ model: 'mock:echo', messages: msg('stream me') });
  check('stream: SSE ends with [DONE] and carries the reply', st.status === 200 && /event-stream/.test(st.type) && st.done && st.text === 'mock reply: stream me', JSON.stringify(st));
  const sRule = await admin('POST', '/routing-rules', { name: 'stream-smart', strategy: 'fallback', match: { model: 'streamy' }, priority: 1, targets: [{ provider: 'mock', model: 'mock:fail' }, { provider: 'mock', model: 'mock:echo' }] });
  await sleep(100);
  const sr = await stream({ model: 'mock:streamy', messages: msg('route stream') });
  check('stream: routing rule + failover apply to streamed requests', sr.status === 200 && sr.text === 'mock reply: route stream', JSON.stringify(sr));
  await admin('DELETE', `/routing-rules/${sRule.json.id}`);
  await sleep(100);

  console.log('\nSDKs against this gateway');
  const sdkRoot = join(root, '..', '..', 'packages');
  const runSdk = (label, cmd, args, cwd) => new Promise(resolve => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, TOKENISTT_BASE_URL: `${BASE}/v1`, TOKENISTT_API_KEY: token, PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d));
    p.on('error', () => resolve({ code: 'missing', out }));
    p.on('close', code => resolve({ code, out }));
  });
  if (existsSync(join(sdkRoot, 'sdk-ts', 'dist', 'cjs', 'index.js')) && existsSync(join(sdkRoot, 'sdk-ts', 'tests', 'live.cjs'))) {
    const r = await runSdk('ts', process.execPath, ['tests/live.cjs'], join(sdkRoot, 'sdk-ts'));
    check('TypeScript SDK passes its live test against the gateway', r.code === 0, r.out.slice(-600));
  } else {
    console.log('  (skipped TypeScript SDK: run `npm run build -w packages/sdk-ts` first)');
  }
  const py = existsSync(join(sdkRoot, 'sdk-python', 'tests', 'live.py'))
    ? await runSdk('py', process.env.PYTHON || 'python', ['tests/live.py'], join(sdkRoot, 'sdk-python'))
    : { code: 'missing', out: '' };
  if (py.code === 'missing' || /No module named 'tokenistt'/.test(py.out)) console.log('  (skipped Python SDK: `pip install -e packages/sdk-python` first)');
  else check('Python SDK passes its live test against the gateway', py.code === 0, py.out.slice(-600));

  console.log('\nUsage + enforcement');
  const me = await fetch(`${BASE}/v1/usage/me`, { headers: { authorization: `Bearer ${token}` } });
  const meBody = await me.json();
  check('GET /v1/usage/me reports this key\'s spend', me.status === 200 && meBody.month.requests >= 1 && meBody.month.cost_usd > 0 && meBody.today.requests >= 1 && Array.isArray(meBody.top_models), JSON.stringify(meBody).slice(0, 240));
  check('GET /v1/usage/me rejects a bad key', (await fetch(`${BASE}/v1/usage/me`, { headers: { authorization: 'Bearer tktt_live_nope' } })).status === 401);
  const enf = await admin('POST', '/policies', { name: 'repo required', conditions: { missing_attribution: ['repo'] }, actions: { effect: 'block', message: 'Send x-tokenistt-repo.' } });
  check('enforcement policy created', enf.status === 201, enf.text);
  const noRepo = await chat(token, { model: 'mock:echo', messages: msg('no attribution') });
  check('request without required attribution is blocked', noRepo.status === 403 && /x-tokenistt-repo/.test(JSON.stringify(noRepo.json)), JSON.stringify(noRepo.json));
  const withRepo = await chat(token, { model: 'mock:echo', messages: msg('with attribution') }, { 'x-tokenistt-repo': 'acme/api' });
  check('same request with the attribution header passes', withRepo.status === 200, JSON.stringify(withRepo.json));
  await admin('DELETE', `/policies/${enf.json.id}`);
  const allow = await admin('POST', '/policies', { name: 'only mock:echo', conditions: { model_not_in: ['mock:echo'] }, actions: { effect: 'block', message: 'Model not on the allow-list.' } });
  const denied = await chat(token, { model: 'mock:other', messages: msg('x') });
  const okModel = await chat(token, { model: 'mock:echo', messages: msg('x') });
  check('model allow-list blocks others and admits listed models', denied.status === 403 && okModel.status === 200, `${denied.status}/${okModel.status}`);
  await admin('DELETE', `/policies/${allow.json.id}`);

  console.log('\nGovernance: approval policy');
  const pol = await admin('POST', '/policies', { name: 'prod deploys need sign-off', conditions: { prompt_keyword: 'deploy-prod' }, actions: { effect: 'require_approval', message: 'needs sign-off' } });
  check('policy created', pol.status === 201, pol.text);
  const held = await chat(token, { model: 'mock:echo', messages: msg('please deploy-prod') });
  check('matching request is held with approval_required', held.status === 403 && held.json?.error?.code === 'approval_required' && !!held.json?.error?.approval_id, JSON.stringify(held.json));
  const dec = await admin('POST', `/approvals/${held.json.error.approval_id}/approve`);
  check('admin approves it', dec.status === 200 && dec.json.status === 'approved', dec.text);
  const passed = await chat(token, { model: 'mock:echo', messages: msg('please deploy-prod') });
  check('retried identical request now passes', passed.status === 200, JSON.stringify(passed.json));
  await admin('DELETE', `/policies/${pol.json.id}`);

  console.log('\nRouting + failover');
  const rule = await admin('POST', '/routing-rules', { name: 'smart', strategy: 'fallback', match: { model: 'smart' }, priority: 1, targets: [{ provider: 'mock', model: 'mock:fail' }, { provider: 'mock', model: 'mock:echo' }] });
  check('routing rule created', rule.status === 201, rule.text);
  await sleep(100);
  const routed = await chat(token, { model: 'mock:smart', messages: msg('route me') });
  check('first target fails (500) → router fails over to the next', routed.status === 200 && routed.json?._tokenistt?.routed_model === 'mock:echo', JSON.stringify(routed.json)?.slice(0, 250));

  console.log('\nBYOK key failover');
  await admin('POST', '/provider-keys', { provider: 'mock', api_key: 'mock-bad-key', label: 'primary', priority: 1 });
  await admin('POST', '/provider-keys', { provider: 'mock', api_key: 'mock-good-key', label: 'secondary', priority: 2 });
  const limited = await chat(token, { model: 'mock:limited', messages: msg('use the second key') });
  check('rate-limited key → next key used', limited.status === 200, JSON.stringify(limited.json)?.slice(0, 250));
  await sleep(300);
  const keys = (await admin('GET', '/provider-keys')).json;
  check('failing key is flagged', keys.find(k => k.label === 'primary')?.status === 'failing', JSON.stringify(keys));

  console.log('\nBudgets');
  const tiny = await admin('POST', '/budgets', { scope_type: 'virtual_key', scope_id: vkInternal, cap_usd: 0.000001 });
  check('sub-cent budget cap is rejected (stored to the cent)', tiny.status === 400, tiny.text);
  // The key has spent fractions of a cent so far; record $5 of prior spend, then cap at $1.
  await pool.query(`INSERT INTO transactions (organization_id, virtual_key_id, provider, model, cost_center, cost_usd) VALUES ($1,$2,'mock','mock:echo','CC-E2E',5)`, [orgId, vkInternal]);
  const b = await admin('POST', '/budgets', { scope_type: 'virtual_key', scope_id: vkInternal, cap_usd: 1, enforcement_mode: 'hard_cap', period: 'monthly' });
  check('budget created', b.status === 201, b.text);
  const blocked = await chat(token, { model: 'mock:echo', messages: msg('over budget') });
  check('over-budget request is blocked with 429 budget_exceeded', blocked.status === 429 && blocked.json?.error?.code === 'budget_exceeded', JSON.stringify(blocked.json));
  await sleep(300);
  const alerts = (await admin('GET', '/alerts')).json;
  check('alert recorded for the breach', Array.isArray(alerts) && alerts.length >= 1, JSON.stringify(alerts));
  await admin('PATCH', `/budgets/${b.json.id}`, { is_active: false });

  console.log('\nAttribution & audit');
  const attr = (await admin('GET', '/attribution')).json;
  check('spend attributed to feature=search and repo=acme/api', attr.some(a => a.dimension === 'feature' && a.value === 'search') && attr.some(a => a.dimension === 'repo' && a.value === 'acme/api'), JSON.stringify(attr).slice(0, 300));
  const audit = (await admin('GET', '/audit')).json;
  const acts = audit.actions.map(a => a.action);
  check('admin actions audited', ['key.create', 'policy.create', 'approval.approve', 'routing_rule.create', 'budget.create'].every(a => acts.includes(a)), acts.join(','));
  const decisions = audit.decisions.map(d => `${d.kind}:${d.decision}`);
  check('automated decisions audited (policy, routing, budget)', ['policy:require_approval', 'routing:route', 'budget:block'].every(d => decisions.includes(d)), decisions.join(','));

  const csv = await fetch(`${BASE}/v1/admin/reports/export?organization_id=${orgId}`, { headers: { 'x-admin-secret': ADMIN_SECRET } });
  check('CSV export works', csv.status === 200 && (await csv.text()).startsWith('cost_center,'));

  const m = await fetch(`${BASE}/metrics`);
  check('/metrics reachable in dev', m.status === 200);
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error('\nE2E aborted:', err.message);
} finally {
  server.kill();
  await sleep(300);
  try {
    if (orgId) {
      for (const t of ['approval_requests', 'budget_alerts', 'budgets', 'policies', 'routing_rules', 'provider_keys', 'transactions', 'virtual_keys', 'workspaces']) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id = $1`, [orgId]);
      }
    }
  } catch { /* best effort cleanup */ }
  await pool.end();
}

const bad = results.filter(r => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length || failed) {
  if (bad.length) {
    console.log('Server log tail:\n' + serverLog.slice(-1500));
    writeFileSync(join(root, 'e2e_server.log'), serverLog);
  }
  process.exit(1);
}
