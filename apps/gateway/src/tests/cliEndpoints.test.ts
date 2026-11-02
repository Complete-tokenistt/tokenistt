import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { managementRouter } from '../routes/management.js';
import { ingestRouter } from '../routes/ingest.js';
import { getPool } from '../db/pool.js';
import { generateVirtualKey } from '../services/keyManager.js';

const hasDb = !!process.env.DATABASE_URL;
const sfx = randomUUID().slice(0, 8);
const JWT_SECRET = 'j'.repeat(40);

let server: http.Server;
let base = '';
let orgA: string;
let orgB: string;
let keyA: string;
let keyB: string;

function jwt(orgId: string, role: string) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: randomUUID(), orgId, email: `${role}@example.com`, role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${h}.${p}.${createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url')}`;
}

async function admin(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(`${base}/v1/admin${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
async function ingest(token: string | null, body: unknown) {
  const r = await fetch(`${base}/v1/ingest/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
const ev = (id: string, extra: Record<string, unknown> = {}) => ({
  event_id: `${sfx}-${id}`, occurred_at: new Date().toISOString(), provider: 'openai', model: 'gpt-4o',
  input_tokens: 1000, output_tokens: 500, latency_ms: 420, ...extra,
});

async function makeKey(org: string, label: string): Promise<string> {
  const pool = getPool();
  const ws = (await pool.query(`INSERT INTO workspaces (organization_id, name, cost_center) VALUES ($1,$2,$3) RETURNING id::text`, [org, `WS ${label} ${sfx}`, `CC-${label}`])).rows[0].id;
  const gen = generateVirtualKey(`ws${label}`, `dev${label}`);
  await pool.query(`INSERT INTO virtual_keys (organization_id, workspace_id, name, key_prefix, key_hash, status) VALUES ($1,$2,$3,$4,$5,'active')`,
    [org, ws, `key-${label}-${sfx}`, gen.keyPrefix, gen.keyHash]);
  return gen.rawToken;
}

describe('CLI endpoints: ingest, usage summary, policy dry-run', { skip: !hasDb && 'DATABASE_URL not set' }, () => {
  before(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const app = express();
    app.use(express.json());
    app.use('/v1/admin', managementRouter);
    app.use('/v1', ingestRouter);
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pool = getPool();
    orgA = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`CliA ${sfx}`, `cli-a-${sfx}`])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`CliB ${sfx}`, `cli-b-${sfx}`])).rows[0].id;
    keyA = await makeKey(orgA, 'a');
    keyB = await makeKey(orgB, 'b');
  });

  after(async () => {
    server.close();
    const pool = getPool();
    for (const org of [orgA, orgB]) {
      for (const t of ['approval_requests', 'policies', 'virtual_keys', 'projects', 'teams', 'workspaces', 'transactions']) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id = $1`, [org]).catch(() => {});
      }
    }
  });

  it('ingest: needs a valid key and a well-formed body', async () => {
    assert.equal((await ingest(null, { schema_version: 1, events: [ev('x')] })).status, 401);
    assert.equal((await ingest('tktt_live_nope_nope_nope', { schema_version: 1, events: [ev('x')] })).status, 401);
    assert.equal((await ingest(keyA, { schema_version: 2, events: [ev('x')] })).status, 400);
    assert.equal((await ingest(keyA, { schema_version: 1, events: [] })).status, 400);
    assert.equal((await ingest(keyA, { schema_version: 1, events: Array.from({ length: 501 }, (_, i) => ev(`big${i}`)) })).status, 400);
  });

  it('ingest: stores events with server-computed cost, deduplicates retries, rejects bad events individually', async () => {
    const batch = {
      schema_version: 1, source: 'cli',
      events: [
        ev('ok1', { attribution: { user: 'u-1', customer: 'acme', lead: 'lead-7', feature: 'search' } }),
        ev('ok2', { model: 'totally-unknown-model-xyz' }),
        ev('bad-cost', { cost_usd: 99 }), // a client-supplied cost is not accepted
        ev('old', { occurred_at: new Date(Date.now() - 90 * 86400_000).toISOString() }),
        { ...ev('neg'), input_tokens: -5 },
      ],
    };
    const first = await ingest(keyA, batch);
    assert.equal(first.status, 200);
    assert.equal(first.json.accepted, 2);
    assert.equal(first.json.rejected, 3);
    const byId = Object.fromEntries(first.json.results.map((r: any) => [r.event_id, r.status]));
    assert.equal(byId[`${sfx}-ok1`], 'accepted');
    assert.equal(byId[`${sfx}-bad-cost`], 'rejected');

    const again = await ingest(keyA, batch);
    assert.equal(again.json.accepted, 0);
    assert.equal(again.json.duplicates, 2);

    const rows = (await getPool().query(
      `SELECT request_id, cost_usd::float AS cost, actor, customer, feature, cost_center, metadata
         FROM transactions WHERE organization_id = $1 ORDER BY request_id`, [orgA])).rows;
    assert.equal(rows.length, 2);
    const known = rows.find((r: any) => r.request_id.endsWith(`${sfx}-ok1`));
    assert.ok(known.cost > 0, 'known model is priced from the catalog');
    assert.equal(known.actor, 'u-1');
    assert.equal(known.customer, 'acme');
    assert.equal(known.cost_center, 'CC-a');
    assert.equal(known.metadata.lead, 'lead-7');
    const unknown = rows.find((r: any) => r.request_id.endsWith(`${sfx}-ok2`));
    assert.equal(unknown.cost, 0);
    assert.equal(unknown.metadata.cost_status, 'COST_UNAVAILABLE');
  });

  it('ingest: the same event_id from another tenant is a separate event and never leaks across', async () => {
    const r = await ingest(keyB, { schema_version: 1, events: [ev('ok1')] });
    assert.equal(r.json.accepted, 1);
    const a = await getPool().query(`SELECT count(*)::int AS n FROM transactions WHERE organization_id = $1`, [orgA]);
    const b = await getPool().query(`SELECT count(*)::int AS n FROM transactions WHERE organization_id = $1`, [orgB]);
    assert.equal(a.rows[0].n, 2);
    assert.equal(b.rows[0].n, 1);
  });

  it('usage/summary: totals, grouping, validation and tenant isolation', async () => {
    const t = jwt(orgA, 'viewer');
    const total = await admin('GET', '/usage/summary', t);
    assert.equal(total.status, 200);
    assert.equal(total.json.rows.length, 1);
    assert.equal(total.json.rows[0].requests, 2);
    assert.equal(total.json.rows[0].input_tokens, '2000');

    const byCustomer = await admin('GET', '/usage/summary?group_by=customer', t);
    assert.equal(byCustomer.status, 200);
    const keys = byCustomer.json.rows.map((r: any) => r.key);
    assert.ok(keys.includes('acme'));
    assert.ok(keys.includes(null), 'events without a customer stay unattributed rather than being invented');

    const byLead = await admin('GET', '/usage/summary?group_by=lead', t);
    assert.ok(byLead.json.rows.some((r: any) => r.key === 'lead-7'));

    assert.equal((await admin('GET', '/usage/summary?group_by=model;DROP TABLE transactions', t)).status, 400);
    assert.equal((await admin('GET', '/usage/summary?since=garbage', t)).status, 400);

    const other = await admin('GET', '/usage/summary', jwt(orgB, 'viewer'));
    assert.equal(other.json.rows[0].requests, 1, 'org B sees only its own event');
  });

  it('whoami reports the principal and organization', async () => {
    const w = await admin('GET', '/whoami', jwt(orgA, 'finance'));
    assert.equal(w.status, 200);
    assert.equal(w.json.role, 'finance');
    assert.match(w.json.organization.slug, /^cli-a-/);
  });

  it('policies/test: evaluates policies without side effects, scoped to the caller’s org', async () => {
    const owner = jwt(orgA, 'owner');
    await admin('POST', '/policies', owner, { name: 'no big models', conditions: { model: 'gpt-4o' }, actions: { effect: 'block', message: 'gpt-4o is blocked' } });
    await admin('POST', '/policies', owner, { name: 'approve opus', conditions: { model: 'opus' }, actions: { effect: 'require_approval' } });
    const countApprovals = async () => (await getPool().query(`SELECT count(*)::int AS n FROM approval_requests WHERE organization_id = $1`, [orgA])).rows[0].n;
    const before = await countApprovals();

    const blocked = await admin('POST', '/policies/test', jwt(orgA, 'viewer'), { model: 'gpt-4o' });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.json.allowed, false);
    assert.equal(blocked.json.code, 'policy_violation');
    assert.equal(blocked.json.matched_policy, 'no big models');
    assert.equal(blocked.json.dry_run, true);

    const needs = await admin('POST', '/policies/test', jwt(orgA, 'viewer'), { model: 'claude-opus-4' });
    assert.equal(needs.json.code, 'approval_required');
    assert.equal(await countApprovals(), before, 'a dry run creates no approval request');

    const free = await admin('POST', '/policies/test', jwt(orgB, 'viewer'), { model: 'gpt-4o' });
    assert.equal(free.json.allowed, true, 'org B has no such policy');

    assert.equal((await admin('POST', '/policies/test', owner, {})).status, 400);

    const audited = await getPool().query(`SELECT count(*)::int AS n FROM audit_log WHERE organization_id = $1 AND action = 'policy.test'`, [orgA]);
    assert.ok(audited.rows[0].n >= 2);
  });
});
