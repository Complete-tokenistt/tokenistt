import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getConnector, listConnectorTypes, ConnectorError } from '../connectors/registry.js';
import { assertSafeUrl, verifyHmac } from '../connectors/http.js';
import { createConnector, runSync, ingestWebhook, deleteConnector } from '../services/connectorService.js';
import { getPool } from '../db/pool.js';

// ── fixture server impersonating the remote APIs ─────────────────────────────
let server: http.Server;
let base = '';
const seen: { url: string; auth?: string }[] = [];

before(async () => {
  process.env.CONNECTORS_ALLOW_PRIVATE_URLS = '1'; // fixtures live on 127.0.0.1
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      seen.push({ url, auth: req.headers.authorization });
      const ok = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const bad = req.headers.authorization?.includes('BAD') || req.headers.authorization === 'BAD';
      if (bad) { res.writeHead(401); return res.end('{"message":"Bad credentials"}'); }

      if (url.startsWith('/user/repos') || url.startsWith('/orgs/acme/repos')) {
        const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? 1);
        if (page === 1) return ok(Array.from({ length: 100 }, (_, i) => ({ full_name: `acme/repo-${i}`, private: false, language: 'TS', archived: false, html_url: 'x' })));
        return ok([{ full_name: 'acme/last-page', private: true }]);
      }
      if (url.startsWith('/orgs/acme/members')) return ok([{ login: 'alice' }, { login: 'bob' }]);
      if (url === '/user') return ok({ login: 'me' });

      if (url.startsWith('/rest/api/3/myself')) return ok({ accountId: '1' });
      if (url.startsWith('/rest/api/3/search/jql')) return ok({ issues: [{ key: 'PAY-7', fields: { summary: 'Fix retries', status: { name: 'Done' }, project: { key: 'PAY' } } }] });
      if (url.startsWith('/rest/agile/1.0/board/9/sprint')) return ok({ values: [{ id: 42, name: 'Sprint 42', state: 'active' }] });

      if (url.startsWith('/auth.test')) return ok({ ok: true });
      if (url.startsWith('/users.list')) return ok({ ok: true, members: [
        { id: 'U1', name: 'carol', real_name: 'Carol', profile: { email: 'carol@acme.com' } },
        { id: 'U2', name: 'robot', is_bot: true }, { id: 'U3', name: 'gone', deleted: true }] });
      if (url.startsWith('/conversations.list')) return ok({ ok: true, channels: [{ id: 'C1', name: 'ai-costs', num_members: 5 }] });

      if (url === '/graphql') {
        if (raw.includes('viewer')) return ok({ data: { viewer: { id: 'v' } } });
        return ok({ data: { issues: { nodes: [{ identifier: 'ENG-1', title: 'Cache', state: { name: 'Todo' }, team: { key: 'ENG' } }] }, cycles: { nodes: [{ id: 'cy1', number: 3 }] } } });
      }

      if (url.includes(':runReport')) return ok({ rows: [{ dimensionValues: [{ value: '/search' }], metricValues: [{ value: '1200' }, { value: '300' }] }] });

      if (url.includes('/services/data/') && url.includes('/limits')) return ok({});
      if (url.includes('/services/data/') && url.includes('/query?')) {
        return ok({ records: [{ Id: '001A', Name: 'Acme Corp', Industry: 'Tech' }], nextRecordsUrl: url.includes('page2') ? undefined : '/services/data/v59.0/query/page2' });
      }
      if (url.includes('/query/page2')) return ok({ records: [{ Id: '001B', Name: 'Globex' }] });

      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); delete process.env.CONNECTORS_ALLOW_PRIVATE_URLS; });

const ctx = (config: Record<string, any>) => ({ config });
const dims = (es: { dimension: string }[]) => es.reduce<Record<string, number>>((m, e) => ((m[e.dimension] = (m[e.dimension] ?? 0) + 1), m), {});

describe('catalogue', () => {
  it('lists all eight connector types without exposing secrets', () => {
    const t = listConnectorTypes();
    assert.deepEqual(t.map(x => x.type).sort(), ['cicd', 'github', 'google-analytics', 'jira', 'linear', 'salesforce', 'slack', 'webhook']);
    assert.ok(t.find(x => x.type === 'github')!.fields.find(f => f.key === 'token')!.secret);
  });
});

describe('pull connectors against fixture APIs', () => {
  it('github: paginates repos, adds org members, sends the bearer token', async () => {
    const gh = getConnector('github')!;
    await gh.authenticate(ctx({ token: 't0k', apiBase: base }));
    const es = await gh.sync!(ctx({ token: 't0k', org: 'acme', apiBase: base }));
    assert.deepEqual(dims(es), { repo: 101, employee: 2 });
    assert.ok(es.some(e => e.externalId === 'acme/last-page'));
    assert.equal(seen.find(s => s.url.startsWith('/orgs/acme/repos'))?.auth, 'Bearer t0k');
  });

  it('github: bad credentials give an actionable error', async () => {
    await assert.rejects(getConnector('github')!.authenticate(ctx({ token: 'BAD', apiBase: base })), /401 \(check the token and its scopes\)/);
  });

  it('jira: tickets and sprints', async () => {
    const es = await getConnector('jira')!.sync!(ctx({ baseUrl: base, email: 'a@b.c', apiToken: 'x', boardId: '9' }));
    assert.deepEqual(es.map(e => [e.dimension, e.externalId]), [['ticket', 'PAY-7'], ['sprint', '42']]);
  });

  it('slack: skips bots and deleted users, keys people by email', async () => {
    const es = await getConnector('slack')!.sync!(ctx({ botToken: 'xoxb-1', apiBase: base }));
    assert.deepEqual(es.map(e => `${e.dimension}:${e.externalId}`), ['employee:carol@acme.com', 'channel:C1']);
  });

  it('linear: issues and cycles via GraphQL', async () => {
    const es = await getConnector('linear')!.sync!(ctx({ apiKey: 'lin_key', apiBase: `${base}/graphql` }));
    assert.deepEqual(es.map(e => `${e.dimension}:${e.externalId}`), ['ticket:ENG-1', 'sprint:cy1']);
  });

  it('google analytics: pages become features with session counts', async () => {
    const es = await getConnector('google-analytics')!.sync!(ctx({ propertyId: '123', accessToken: 'ya29', dataApiBase: base }));
    assert.deepEqual(es[0], { dimension: 'feature', externalId: '/search', name: '/search', data: { sessions: 1200, activeUsers: 300 } });
  });

  it('salesforce: follows nextRecordsUrl and yields customers', async () => {
    const es = await getConnector('salesforce')!.sync!(ctx({ instanceUrl: base, accessToken: 'sf' }));
    assert.deepEqual(es.map(e => e.externalId), ['001A', '001B']);
    assert.ok(es.every(e => e.dimension === 'customer'));
  });

  it('missing config is reported by name', async () => {
    await assert.rejects(getConnector('jira')!.authenticate(ctx({ baseUrl: base })), /Missing required config: email, apiToken/);
  });
});

describe('webhook connectors', () => {
  const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const req = (secret: string, payload: unknown, extra: Record<string, string> = {}, sig = true) => {
    const raw = Buffer.from(JSON.stringify(payload));
    return { rawBody: raw, body: payload, headers: { ...(sig ? { 'x-tokenistt-signature': sign(secret, raw.toString()) } : {}), ...extra } };
  };

  it('custom webhook: valid signature accepted, tampered/missing rejected', async () => {
    const wh = getConnector('webhook')!;
    const payload = { entities: [{ dimension: 'customer', external_id: 'c-1', name: 'Initech' }] };
    const es = await wh.webhook!(ctx({ secret: 's3' }), req('s3', payload));
    assert.deepEqual(es, [{ dimension: 'customer', externalId: 'c-1', name: 'Initech', data: {} }]);

    await assert.rejects(wh.webhook!(ctx({ secret: 'other' }), req('s3', payload)), /Invalid signature/);
    await assert.rejects(wh.webhook!(ctx({ secret: 's3' }), req('s3', payload, {}, false)), /Invalid signature/);
    const bad = { entities: [{ dimension: 'galaxy', external_id: 'x' }] };
    await assert.rejects(wh.webhook!(ctx({ secret: 's3' }), req('s3', bad)), /dimension is invalid/);
  });

  it('cicd: GitHub Actions (HMAC), GitLab (token), generic', async () => {
    const ci = getConnector('cicd')!;
    const gh = { workflow_run: { id: 99, name: 'deploy', conclusion: 'success', head_branch: 'main', head_sha: 'abc' }, repository: { full_name: 'acme/api' } };
    const r1 = req('hook', gh, {}, false);
    r1.headers = { 'x-hub-signature-256': sign('hook', r1.rawBody.toString()) } as any;
    const [d1] = await ci.webhook!(ctx({ secret: 'hook' }), r1);
    assert.deepEqual([d1.dimension, d1.externalId, (d1.data as any).repo], ['deployment', '99', 'acme/api']);

    const gl = { object_kind: 'pipeline', object_attributes: { id: 7, status: 'success', ref: 'main' }, project: { path_with_namespace: 'g/p' } };
    const [d2] = await ci.webhook!(ctx({ secret: 'tok' }), { rawBody: Buffer.from(JSON.stringify(gl)), body: gl, headers: { 'x-gitlab-token': 'tok' } });
    assert.equal(d2.externalId, '7');

    await assert.rejects(ci.webhook!(ctx({ secret: 'tok' }), { rawBody: Buffer.from('{}'), body: {}, headers: { 'x-gitlab-token': 'wrong' } }), /Invalid signature/);
  });

  it('verifyHmac is constant-time safe on malformed input', () => {
    assert.equal(verifyHmac('s', Buffer.from('x'), undefined), false);
    assert.equal(verifyHmac('s', Buffer.from('x'), 'sha256=zz'), false);
  });
});

describe('SSRF protection', () => {
  it('refuses http, private and metadata addresses, embedded credentials', async () => {
    delete process.env.CONNECTORS_ALLOW_PRIVATE_URLS;
    try {
      await assert.rejects(assertSafeUrl('http://example.com/x'), /must use https/);
      await assert.rejects(assertSafeUrl('https://127.0.0.1/x'), /private address/);
      await assert.rejects(assertSafeUrl('https://169.254.169.254/latest/meta-data'), /private address/);
      await assert.rejects(assertSafeUrl('https://10.0.0.5'), /private address/);
      await assert.rejects(assertSafeUrl('https://[::1]/'), /private address/);
      await assert.rejects(assertSafeUrl('https://user:pw@8.8.8.8/'), /Credentials in URLs/);
      await assert.doesNotReject(assertSafeUrl('https://8.8.8.8/'));
      await assert.rejects(assertSafeUrl('not a url'), ConnectorError);
    } finally {
      process.env.CONNECTORS_ALLOW_PRIVATE_URLS = '1';
    }
  });
});

const hasDb = !!process.env.DATABASE_URL;
describe('connector service against Postgres', { skip: !hasDb && 'DATABASE_URL not set' }, () => {
  const sfx = randomUUID().slice(0, 8);
  let orgId: string;

  before(async () => {
    orgId = (await getPool().query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`Conn ${sfx}`, `conn-${sfx}`])).rows[0].id;
  });
  after(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM transactions WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM connectors WHERE organization_id = $1', [orgId]);
  });

  it('stores config encrypted, verifies credentials on create, never returns secrets', async () => {
    await assert.rejects(createConnector(orgId, 'github', 'bad', { token: 'BAD', apiBase: base }), /401/);
    const row = await createConnector(orgId, 'github', 'acme-gh', { token: 'ghp_supersecret', org: 'acme', apiBase: base });
    assert.ok(!JSON.stringify(row).includes('ghp_supersecret'));
    const stored = (await getPool().query('SELECT encrypted_config FROM connectors WHERE public_id::text = $1', [row.id])).rows[0].encrypted_config;
    assert.ok(!stored.includes('ghp_supersecret'));
    await assert.rejects(createConnector(orgId, 'nope', 'x', {}), /Unknown connector type/);
    await assert.rejects(createConnector(orgId, 'jira', 'x', { baseUrl: base }), /Missing required config/);
  });

  it('sync upserts entities idempotently and records runs; spend joins entity names', async () => {
    const pool = getPool();
    const c = (await pool.query(`SELECT public_id::text AS id FROM connectors WHERE organization_id = $1`, [orgId])).rows[0].id;

    const first = await runSync(c, orgId);
    const again = await runSync(c, orgId);
    assert.equal(first.entities, 103);
    assert.equal(again.entities, 103);
    const count = (await pool.query(`SELECT COUNT(*)::int AS n FROM connector_entities WHERE organization_id = $1`, [orgId])).rows[0].n;
    assert.equal(count, 103, 'second sync updates, does not duplicate');
    const runs = (await pool.query(`SELECT r.status FROM connector_sync_runs r JOIN connectors c ON c.id = r.connector_id WHERE c.organization_id = $1`, [orgId])).rows;
    assert.deepEqual(runs.map(r => r.status), ['success', 'success']);

    await pool.query(
      `INSERT INTO transactions (organization_id, provider, model, cost_center, cost_usd, repo, customer, actor)
       VALUES ($1,'openai','gpt-4o','CC',2.5,'acme/repo-3','c-1','dev@x.io'), ($1,'openai','gpt-4o','CC',1.0,'acme/repo-3',NULL,'dev@x.io')`, [orgId]);
    const v = (await pool.query(
      `SELECT dimension, value, label, cost_usd::text, requests::int FROM v_cost_by_dimension WHERE organization_id = $1 ORDER BY dimension, value`, [orgId])).rows;
    const repo = v.find(r => r.dimension === 'repo');
    assert.deepEqual([repo.value, repo.cost_usd, repo.requests], ['acme/repo-3', '3.500000', 2]);
    assert.equal(repo.label, 'acme/repo-3');
    assert.ok(v.some(r => r.dimension === 'employee' && r.value === 'dev@x.io'));
  });

  it('a failing sync marks the connector as errored and surfaces the reason', async () => {
    const pool = getPool();
    const row = await createConnector(orgId, 'linear', 'lin', { apiKey: 'ok', apiBase: `${base}/graphql` });
    await pool.query(`UPDATE connectors SET encrypted_config = (SELECT encrypted_config FROM connectors WHERE name = 'acme-gh' AND organization_id = $2) WHERE public_id::text = $1`, [row.id, orgId]);
    await assert.rejects(runSync(row.id, orgId));
    const after = (await pool.query(`SELECT status, last_error FROM connectors WHERE public_id::text = $1`, [row.id])).rows[0];
    assert.equal(after.status, 'error');
    assert.ok(after.last_error);
  });

  it('webhook ingest: valid signature stores entities; unknown id and bad signature look identical', async () => {
    const wh = await createConnector(orgId, 'webhook', 'crm-push', { secret: 'whsec' });
    const payload = { entities: [{ dimension: 'customer', external_id: 'cust-9', name: 'Hooli' }] };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = `sha256=${createHmac('sha256', 'whsec').update(raw).digest('hex')}`;

    const ok = await ingestWebhook(wh.id, { rawBody: raw, body: payload, headers: { 'x-tokenistt-signature': sig } });
    assert.equal(ok.entities, 1);
    const name = (await getPool().query(`SELECT name FROM connector_entities WHERE organization_id = $1 AND external_id = 'cust-9'`, [orgId])).rows[0].name;
    assert.equal(name, 'Hooli');

    const wrong = await ingestWebhook(wh.id, { rawBody: raw, body: payload, headers: { 'x-tokenistt-signature': 'sha256=00' } }).catch(e => e);
    const unknown = await ingestWebhook(randomUUID(), { rawBody: raw, body: payload, headers: { 'x-tokenistt-signature': sig } }).catch(e => e);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.message, unknown.message);

    assert.equal(await deleteConnector(orgId, wh.id), true);
  });
});
