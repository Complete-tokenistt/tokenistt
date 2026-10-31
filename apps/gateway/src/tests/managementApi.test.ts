import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { managementRouter } from '../routes/management.js';
import { getPool } from '../db/pool.js';
import { requestFingerprint, createApproval } from '../services/approvals.js';
import { hashToken } from '../services/keyManager.js';

const hasDb = !!process.env.DATABASE_URL;
const sfx = randomUUID().slice(0, 8);
const JWT_SECRET = 'j'.repeat(40);
const ADMIN_SECRET = 'admin-secret-for-tests-0123456789abcdef';

let server: http.Server;
let base = '';
let orgA: string;
let orgB: string;

function jwt(orgId: string, role: string, email = `${role}@example.com`, expOffset = 3600) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: randomUUID(), orgId, email, role, exp: Math.floor(Date.now() / 1000) + expOffset })).toString('base64url');
  const sig = createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

async function call(method: string, path: string, opts: { token?: string; secret?: string; body?: unknown; query?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.secret) headers['x-admin-secret'] = opts.secret;
  const r = await fetch(`${base}/v1/admin${path}${opts.query ?? ''}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, json, text, headers: r.headers };
}

describe('management API (RBAC, tenancy, audit)', { skip: !hasDb && 'DATABASE_URL not set' }, () => {
  before(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.ADMIN_SECRET = ADMIN_SECRET;
    const app = express();
    app.use(express.json());
    app.use('/v1/admin', managementRouter);
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pool = getPool();
    orgA = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`MgmtA ${sfx}`, `mgmt-a-${sfx}`])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`MgmtB ${sfx}`, `mgmt-b-${sfx}`])).rows[0].id;
  });

  after(async () => {
    server.close();
    const pool = getPool();
    for (const org of [orgA, orgB]) {
      for (const t of ['approval_requests', 'budgets', 'policies', 'routing_rules', 'provider_keys', 'virtual_keys', 'projects', 'teams', 'workspaces', 'transactions']) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id = $1`, [org]);
      }
    }
  });

  it('rejects missing, wrong and expired credentials', async () => {
    assert.equal((await call('GET', '/budgets')).status, 401);
    assert.equal((await call('GET', '/budgets', { secret: 'nope' })).status, 401);
    assert.equal((await call('GET', '/budgets', { token: jwt(orgA, 'owner', 'x@y.z', -10) })).status, 401);
    assert.equal((await call('GET', '/budgets', { token: 'a.b.c' })).status, 401);
  });

  it('operator must name an organization; user tokens are locked to theirs', async () => {
    assert.equal((await call('GET', '/budgets', { secret: ADMIN_SECRET })).status, 400);
    assert.equal((await call('GET', '/budgets', { secret: ADMIN_SECRET, query: `?organization_id=${orgA}` })).status, 200);
    assert.equal((await call('GET', '/budgets', { token: jwt(orgA, 'viewer'), query: `?organization_id=${orgB}` })).status, 400);
  });

  it('RBAC: viewer can read but not write budgets; finance can write', async () => {
    const body = { scope_type: 'organization', scope_id: orgA, cap_usd: 100, enforcement_mode: 'alert_only' };
    assert.equal((await call('GET', '/budgets', { token: jwt(orgA, 'viewer') })).status, 200);
    const denied = await call('POST', '/budgets', { token: jwt(orgA, 'viewer'), body });
    assert.equal(denied.status, 403);
    assert.match(denied.json.error.message, /lacks permission 'budget:write'/);
    const ok = await call('POST', '/budgets', { token: jwt(orgA, 'finance'), body });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.cap_usd, '100.00');
    assert.equal(ok.json.__created, undefined);
  });

  it('validates input', async () => {
    const t = jwt(orgA, 'owner');
    assert.equal((await call('POST', '/budgets', { token: t, body: { scope_type: 'galaxy', scope_id: 1, cap_usd: 5 } })).status, 400);
    assert.equal((await call('POST', '/budgets', { token: t, body: { scope_type: 'team', scope_id: 'abc', cap_usd: 5 } })).status, 400);
    assert.equal((await call('POST', '/policies', { token: t, body: { name: 'x', actions: { effect: 'explode' } } })).status, 400);
    assert.equal((await call('POST', '/routing-rules', { token: t, body: { name: 'r', strategy: 'cheapest', targets: [] } })).status, 400);
  });

  it('tenants cannot see or modify each other’s data', async () => {
    const created = await call('POST', '/policies', { token: jwt(orgA, 'admin'), body: { name: 'A only', actions: { effect: 'block', message: 'no' } } });
    assert.equal(created.status, 201);
    const id = created.json.id;

    const listB = await call('GET', '/policies', { token: jwt(orgB, 'owner') });
    assert.deepEqual(listB.json.filter((p: any) => p.id === id), []);
    assert.equal((await call('PATCH', `/policies/${id}`, { token: jwt(orgB, 'owner'), body: { name: 'hijack' } })).status, 404);
    assert.equal((await call('DELETE', `/policies/${id}`, { token: jwt(orgB, 'owner') })).status, 404);
    assert.equal((await call('PATCH', `/policies/${id}`, { token: jwt(orgA, 'admin'), body: { is_enabled: false } })).json.is_enabled, false);
  });

  it('routing rules CRUD; provider keys never expose secrets and are encrypted at rest', async () => {
    const t = jwt(orgA, 'developer');
    const rule = await call('POST', '/routing-rules', { token: t, body: { name: 'cheap', strategy: 'cheapest', priority: 5, targets: [{ provider: 'openai', model: 'gpt-4o-mini' }] } });
    assert.equal(rule.status, 201);
    assert.equal((await call('GET', '/routing-rules', { token: t })).json.length, 1);

    const pk = await call('POST', '/provider-keys', { token: t, body: { provider: 'OpenAI', api_key: 'sk-super-secret-value', label: 'main', priority: 1 } });
    assert.equal(pk.status, 201);
    assert.ok(!JSON.stringify(pk.json).includes('sk-super-secret'));
    const list = await call('GET', '/provider-keys', { token: t });
    assert.ok(!list.text.includes('sk-super-secret') && !list.text.includes('encrypted'));
    const stored = await getPool().query('SELECT encrypted_key, provider FROM provider_keys WHERE organization_id = $1', [orgA]);
    assert.equal(stored.rows[0].provider, 'openai');
    assert.ok(!stored.rows[0].encrypted_key.includes('sk-super-secret'));
    assert.equal((await call('DELETE', `/provider-keys/${pk.json.id}`, { token: t })).status, 200);
  });

  it('POST /keys creates a usable virtual key: token shown once, only its hash stored', async () => {
    const t = jwt(orgA, 'developer');
    const r = await call('POST', '/keys', { token: t, body: { name: 'ci-bot', budgetCapUsd: 25, provider: 'openai' } });
    assert.equal(r.status, 201);
    assert.match(r.json.token, /^tktt_live_/);
    const row = (await getPool().query('SELECT key_hash, budget_cap_usd::text AS cap, allowed_providers FROM virtual_keys WHERE public_id::text = $1', [r.json.id])).rows[0];
    assert.equal(row.key_hash, hashToken(r.json.token));
    assert.equal(row.cap, '25.00');
    assert.deepEqual(row.allowed_providers, ['openai']);
    assert.equal((await call('POST', '/keys', { token: jwt(orgA, 'viewer'), body: { name: 'nope' } })).status, 403);
    assert.equal((await call('POST', '/keys', { token: t, body: {} })).status, 400);
  });

  it('teams/projects require slugs; duplicates conflict', async () => {
    const t = jwt(orgA, 'owner');
    assert.equal((await call('POST', '/teams', { token: t, body: { name: 'Bad', slug: 'Bad Slug' } })).status, 400);
    const team = await call('POST', '/teams', { token: t, body: { name: 'Search', slug: 'search' } });
    assert.equal(team.status, 201);
    assert.equal((await call('POST', '/teams', { token: t, body: { name: 'Search2', slug: 'search' } })).status, 409);
    const proj = await call('POST', '/projects', { token: t, body: { name: 'Ranker', slug: 'ranker', team_id: team.json.id } });
    assert.equal(proj.status, 201);
    assert.equal(proj.json.team_id, team.json.id);
  });

  it('approvals: only authorised roles decide; cross-org and double decisions are refused', async () => {
    const pool = getPool();
    const vk = (await pool.query(`INSERT INTO virtual_keys (organization_id, name, key_prefix, key_hash) VALUES ($1,'a','p','h') RETURNING id`, [orgA])).rows[0].id;
    const auth: any = { organizationId: BigInt(orgA), virtualKeyId: BigInt(vk), actor: 'dev', costCenter: 'CC' };
    const req: any = { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] };
    const appr = await createApproval({ auth, policyId: null, fingerprint: requestFingerprint(auth, req), model: 'gpt-4o', reason: 'big spend' });

    assert.equal((await call('POST', `/approvals/${appr.public_id}/approve`, { token: jwt(orgA, 'developer') })).status, 403);
    assert.equal((await call('POST', `/approvals/${appr.public_id}/approve`, { token: jwt(orgB, 'owner') })).status, 404);
    const ok = await call('POST', `/approvals/${appr.public_id}/approve`, { token: jwt(orgA, 'finance', 'cfo@example.com') });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.decided_by, 'cfo@example.com');
    assert.equal((await call('POST', `/approvals/${appr.public_id}/deny`, { token: jwt(orgA, 'owner') })).status, 409);
  });

  it('every mutation is in the audit trail, attributed to the caller', async () => {
    await new Promise(r => setTimeout(r, 400)); // fire-and-forget writes
    const r = await call('GET', '/audit', { token: jwt(orgA, 'admin') });
    assert.equal(r.status, 200);
    const actions = r.json.actions.map((a: any) => a.action);
    for (const a of ['budget.create', 'policy.create', 'policy.update', 'routing_rule.create', 'provider_key.create', 'key.create', 'team.create', 'approval.approve']) {
      assert.ok(actions.includes(a), `missing audit entry ${a}`);
    }
    const pk = r.json.actions.find((a: any) => a.action === 'provider_key.create');
    assert.ok(!JSON.stringify(pk).includes('sk-super-secret'));
    assert.equal(r.json.actions.find((a: any) => a.action === 'budget.create').actor, 'finance@example.com');
    assert.equal((await call('GET', '/audit', { token: jwt(orgA, 'viewer') })).status, 403);
  });

  it('CSV export: per cost center, formula-injection safe, validated month', async () => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO transactions (organization_id, provider, model, cost_center, cost_usd, prompt_tokens, created_at)
       VALUES ($1,'openai','gpt-4o','=HYPERLINK("x")',1.5,10,'2026-03-10')`, [orgA]);
    const r = await call('GET', '/reports/export', { token: jwt(orgA, 'finance'), query: '?month=2026-03' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/csv/);
    assert.ok(r.text.startsWith('cost_center,provider,model'));
    assert.ok(r.text.includes(`"'=HYPERLINK(""x"")"`), 'formula neutralised and quoted');
    assert.equal((await call('GET', '/reports/export', { token: jwt(orgA, 'finance'), query: '?month=2026-13' })).status, 400);
    assert.equal((await call('GET', '/reports/export', { token: jwt(orgA, 'developer') })).status, 403);
  });

  it('request history is paginated and tenant-scoped', async () => {
    const r = await call('GET', '/requests', { token: jwt(orgA, 'viewer'), query: '?limit=1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.length, 1);
    assert.equal((await call('GET', '/requests', { token: jwt(orgB, 'viewer') })).json.data.length, 0);
  });
});
