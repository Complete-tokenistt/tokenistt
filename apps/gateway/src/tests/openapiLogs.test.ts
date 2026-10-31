import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ROUTES, buildOpenApi } from '../openapi.js';
import { managementRouter } from '../routes/management.js';
import { logsRouter } from '../routes/logs.js';
import { getPool } from '../db/pool.js';
import { generateVirtualKey } from '../services/keyManager.js';

/** Every route the management router registers must be documented. */
function registered(router: any, prefix: string): string[] {
  const out: string[] = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push(`${method} ${prefix}${String(layer.route.path).replace(/:(\w+)/g, '{$1}')}`);
    }
  }
  return out;
}

describe('OpenAPI document', () => {
  const documented = new Set(ROUTES.map(r => `${r.method} ${r.path}`));

  it('documents every management route (no drift)', () => {
    const missing = registered(managementRouter, '/v1/admin').filter(r => !documented.has(r));
    assert.deepEqual(missing, []);
  });

  it('documents the logs route and has no duplicate entries', () => {
    assert.deepEqual(registered(logsRouter, '/v1').filter(r => !documented.has(r)), []);
    assert.equal(documented.size, ROUTES.length);
  });

  it('is a well-formed OpenAPI 3.1 skeleton with security schemes and path params', () => {
    const doc: any = buildOpenApi();
    assert.equal(doc.openapi, '3.1.0');
    assert.ok(doc.components.securitySchemes.virtualKey && doc.components.securitySchemes.adminSecret);
    const op = doc.paths['/v1/admin/budgets/{id}'].patch;
    assert.equal(op.parameters[0].name, 'id');
    assert.deepEqual(doc.paths['/health'].get.security, []);
    assert.equal(doc.info.license.name, 'Apache-2.0');
  });
});

const hasDb = !!process.env.DATABASE_URL;
describe('GET /v1/logs', { skip: !hasDb && 'DATABASE_URL not set' }, () => {
  let server: http.Server;
  let base = '';
  let orgId: string;
  let tokenA: string;
  let tokenB: string;

  before(async () => {
    const app = express();
    app.use('/v1', logsRouter);
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pool = getPool();
    const sfx = randomUUID().slice(0, 8);
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`Logs ${sfx}`, `logs-${sfx}`])).rows[0].id;
    const mk = async (name: string) => {
      const k = generateVirtualKey('org', name);
      const id = (await pool.query(
        `INSERT INTO virtual_keys (organization_id, name, key_prefix, key_hash) VALUES ($1,$2,$3,$4) RETURNING id::text`,
        [orgId, name, k.keyPrefix, k.keyHash])).rows[0].id;
      return { token: k.rawToken, id };
    };
    const a = await mk('a'); const b = await mk('b');
    tokenA = a.token; tokenB = b.token;
    for (let i = 0; i < 3; i++) {
      await pool.query(`INSERT INTO transactions (organization_id, virtual_key_id, provider, model, cost_center, cost_usd, status) VALUES ($1,$2,'openai','gpt-4o','CC',0.01,$3)`, [orgId, a.id, i === 2 ? 'error' : 'success']);
    }
    await pool.query(`INSERT INTO transactions (organization_id, virtual_key_id, provider, model, cost_center, cost_usd) VALUES ($1,$2,'openai','gpt-4o','CC',0.5)`, [orgId, b.id]);
  });
  after(async () => {
    server.close();
    const pool = getPool();
    await pool.query('DELETE FROM transactions WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM virtual_keys WHERE organization_id = $1', [orgId]);
  });

  const get = (q = '', token?: string) => fetch(`${base}/v1/logs${q}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  it('requires a valid key', async () => {
    assert.equal((await get()).status, 401);
    assert.equal((await get('', 'tktt_live_nope')).status, 401);
  });

  it('returns only the calling key’s rows, paginated, filterable by status', async () => {
    const page1: any = await (await get('?limit=2', tokenA)).json();
    assert.equal(page1.data.length, 2);
    assert.ok(page1.next_before);
    const page2: any = await (await get(`?limit=2&before=${page1.next_before}`, tokenA)).json();
    assert.equal(page2.data.length, 1);
    assert.equal(page2.next_before, null);
    assert.equal((await (await get('?status=error', tokenA)).json() as any).data.length, 1);
    const b: any = await (await get('', tokenB)).json();
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].cost_usd, '0.500000');
  });

  it('revoked keys lose access', async () => {
    await getPool().query(`UPDATE virtual_keys SET status = 'revoked' WHERE organization_id = $1 AND name = 'b'`, [orgId]);
    assert.equal((await get('', tokenB)).status, 401);
  });
});
