import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { managementRouter } from '../routes/management.js';
import { syncRouter } from '../routes/sync.js';
import { getPool } from '../db/pool.js';
import { generateVirtualKey } from '../services/keyManager.js';

const hasDb = !!process.env.DATABASE_URL;
const sfx = randomUUID().slice(0, 8);
const JWT_SECRET = 'j'.repeat(40);
const KEY_A = `repo_${'a'.repeat(16)}`;

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
async function admin(path: string, token: string) {
  const r = await fetch(`${base}/v1/admin${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
async function sync(token: string | null, body: unknown) {
  const r = await fetch(`${base}/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
async function makeKey(org: string, label: string): Promise<string> {
  const pool = getPool();
  const ws = (await pool.query(`INSERT INTO workspaces (organization_id, name, cost_center) VALUES ($1,$2,$3) RETURNING id`, [org, `ws-${label}-${sfx}`, `cc-${label}-${sfx}`])).rows[0].id;
  const gen = generateVirtualKey(`ws${label}`, `dev${label}`);
  await pool.query(`INSERT INTO virtual_keys (organization_id, workspace_id, name, key_prefix, key_hash, status) VALUES ($1,$2,$3,$4,$5,'active')`, [org, ws, `key-${label}-${sfx}`, gen.keyPrefix, gen.keyHash]);
  return gen.rawToken;
}

const T1 = '2026-11-02T10:00:00.000Z';
const T2 = '2026-11-02T11:00:00.000Z';
const session = (over: Record<string, unknown> = {}) => ({
  agent: 'claude-code', session_id: `s-${sfx}`, branch: 'main', state: 'ended', started_at: T1, ended_at: T2, last_event_at: T2, models: ['m'],
  tokens: { input: 1, output: 2, cache_read: 3, cache_creation: 4, total: 10, requests: 1 }, cost_usd: null, cost_source: 'unknown', counts: { errors: 1 }, changed_files: ['src/a.ts'], ...over,
});
const memory = (over: Record<string, unknown> = {}) => ({ key: 'stack', category: 'TECH_STACK', content: 'TypeScript', source_kind: 'detection', source_ref: 'manifests', status: 'active', updated_at: T1, ...over });
const payload = (over: Record<string, unknown> = {}) => ({ schema_version: 1, repository: { project_key: KEY_A, name: 'demo', branch: 'main', commit: 'abc1234' }, ...over });

describe('CLI sync', { skip: !hasDb }, () => {
  before(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const pool = getPool();
    orgA = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`A ${sfx}`, `a-${sfx}`])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`B ${sfx}`, `b-${sfx}`])).rows[0].id;
    keyA = await makeKey(orgA, 'a');
    keyB = await makeKey(orgB, 'b');
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/v1', syncRouter);
    app.use('/v1/admin', managementRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    const pool = getPool();
    for (const org of [orgA, orgB]) {
      await pool.query(`DELETE FROM code_repositories WHERE organization_id = $1`, [org]).catch(() => {});
      await pool.query(`DELETE FROM virtual_keys WHERE organization_id = $1`, [org]).catch(() => {});
      await pool.query(`DELETE FROM workspaces WHERE organization_id = $1`, [org]).catch(() => {});
    }
  });

  it('requires a valid key', async () => {
    assert.equal((await sync(null, payload())).status, 401);
    assert.equal((await sync('tktt_live_nope', payload())).status, 401);
  });

  it('rejects anything that is not an allowed field: no prompts, transcripts or machine paths', async () => {
    const reject = async (body: unknown) => assert.equal((await sync(keyA, body)).status, 400, JSON.stringify(body));
    await reject({ repository: {} });
    await reject(payload({ schema_version: 99 }));
    await reject(payload({ organization_id: orgB }));
    await reject(payload({ sessions: [session({ prompt: 'secret prompt' })] }));
    await reject(payload({ sessions: [session({ transcript: '/home/me/x.jsonl' })] }));
    for (const bad of ['/home/me/a.ts', 'C:\\Users\\me\\a.ts', '../outside.ts', 'a/../../b.ts', '\\\\server\\x']) await reject(payload({ sessions: [session({ changed_files: [bad] })] }));
    await reject(payload({ memories: [memory({ embedding: [1] })] }));
    await reject({ schema_version: 1, repository: { project_key: 'not-a-key', name: 'x' } });
  });

  it('stores a repository, sessions, memory and graph, readable through the management API', async () => {
    const r = await sync(keyA, payload({
      graph: { stats: { nodes: { file: 3 }, edges: { CALLS: 2 }, files: 3 }, modules: [{ name: 'core', path: 'packages/core', files: 3, dependencies: [] }] },
      sessions: [session()], memories: [memory()],
    }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sessions, 1);
    const viewer = jwt(orgA, 'viewer');
    const repos = await admin('/repositories', viewer);
    assert.equal(repos.json.length, 1);
    assert.equal(repos.json[0].sessions, 1);
    assert.equal(repos.json[0].memories, 1);
    const id = repos.json[0].id;
    const graph = await admin(`/repositories/${id}/graph`, viewer);
    assert.equal(graph.json.modules[0].name, 'core');
    assert.equal(graph.json.stats.files, 3);
    const mem = await admin(`/repositories/${id}/memories`, viewer);
    assert.equal(mem.json[0].content, 'TypeScript');
    assert.equal(mem.json[0].source_ref, 'manifests');
    assert.equal((await admin(`/repositories/${id}/memories?category=OPEN_TASKS`, viewer)).json.length, 0);
    const sessions = await admin('/agent-sessions', viewer);
    assert.equal(sessions.json[0].tokens.total, 10);
    assert.equal(sessions.json[0].cost_usd, null);
    assert.equal(sessions.json[0].cost_source, 'unknown');
    assert.deepEqual(sessions.json[0].changed_files, ['src/a.ts']);
    assert.equal((await admin('/agent-sessions?agent=codex', viewer)).json.length, 0);
    assert.equal((await admin(`/agent-sessions?repository=${id}`, viewer)).json.length, 1);
    assert.equal((await admin('/agent-sessions?repository=not-a-uuid', viewer)).status, 400);
  });

  it('is idempotent, and an older update never overwrites a newer one', async () => {
    const before = (await admin('/agent-sessions', jwt(orgA, 'viewer'))).json.length;
    await sync(keyA, payload({ sessions: [session()], memories: [memory()] }));
    assert.equal((await admin('/agent-sessions', jwt(orgA, 'viewer'))).json.length, before);
    const stale = await sync(keyA, payload({ sessions: [session({ last_event_at: T1, state: 'active' })], memories: [memory({ content: 'Older', updated_at: '2026-01-01T00:00:00.000Z' })] }));
    assert.equal(stale.json.sessions, 0);
    assert.equal(stale.json.memories, 0);
    const rows = (await admin('/agent-sessions', jwt(orgA, 'viewer'))).json;
    assert.equal(rows[0].state, 'ended');
    const newer = await sync(keyA, payload({ memories: [memory({ content: 'Newer', updated_at: T2 })] }));
    assert.equal(newer.json.memories, 1);
  });

  it('keeps an unknown as unknown, and an estimate labelled as one', async () => {
    await sync(keyA, payload({ sessions: [
      session({ session_id: `unknown-${sfx}`, tokens: null, cost_usd: null }),
      session({ session_id: `priced-${sfx}`, cost_usd: 1.5, cost_source: 'catalog_estimate' }),
      session({ session_id: `mislabelled-${sfx}`, cost_usd: 9, cost_source: 'unknown' }),
    ] }));
    const rows = (await admin('/agent-sessions?limit=200', jwt(orgA, 'viewer'))).json as any[];
    const by = (s: string) => rows.find((r) => r.session_id === `${s}-${sfx}`);
    assert.equal(by('unknown').tokens, null);
    assert.equal(by('priced').cost_usd, 1.5);
    assert.equal(by('priced').cost_source, 'catalog_estimate');
    assert.equal(by('mislabelled').cost_usd, null, 'a cost with no basis is not stored');
  });

  it('never touches the spend ledger, so budgets are unaffected', async () => {
    const n = (await getPool().query(`SELECT count(*)::int AS n FROM transactions WHERE organization_id = $1`, [orgA])).rows[0].n;
    assert.equal(n, 0);
  });

  it('isolates organizations: same project key, separate data, and no reading across', async () => {
    const r = await sync(keyB, payload({ sessions: [session({ session_id: 'b-only' })] }));
    assert.equal(r.status, 200);
    const a = await admin('/repositories', jwt(orgA, 'viewer'));
    const b = await admin('/repositories', jwt(orgB, 'viewer'));
    assert.equal(b.json.length, 1);
    assert.notEqual(a.json[0].id, b.json[0].id);
    const aSessions = (await admin('/agent-sessions?limit=200', jwt(orgA, 'viewer'))).json as any[];
    assert.equal(aSessions.some((s) => s.session_id === 'b-only'), false);
    const bId = b.json[0].id;
    assert.equal((await admin(`/repositories/${bId}/graph`, jwt(orgA, 'viewer'))).status, 404);
    assert.equal((await admin(`/repositories/${bId}/memories`, jwt(orgA, 'owner'))).status, 404);
    assert.equal((await admin(`/agent-sessions?repository=${bId}`, jwt(orgA, 'viewer'))).json.length, 0);
  });

  it('requires management credentials to read', async () => {
    assert.equal((await fetch(`${base}/v1/admin/repositories`)).status, 401);
  });
});
