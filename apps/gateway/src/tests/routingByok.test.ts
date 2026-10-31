import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rankTargets, ruleMatches, resolveRoute, clearRoutingCache, type RoutingRule } from '../services/routingEngine.js';
import { SmartRouter } from '../services/router.js';
import { resolveKeys, isKeyFailure, addProviderKey } from '../services/byok.js';
import { GatewayError } from '../types/index.js';
import { getPool } from '../db/pool.js';
import type { AuthContext } from '../db/auth.js';

const T = (provider: string, model: string) => ({ provider, model });
const baseAuth = (over: Partial<AuthContext> = {}): AuthContext => ({
  virtualKeyId: 1n, virtualKeyPublicId: 'vk', workspaceId: null, organizationId: 0n, costCenter: 'CC-1',
  actor: 'a', budgetCapUsd: null, budgetUsedUsd: 0, budgetPeriod: 'monthly', allowedProviders: [],
  realApiKey: null, ...over,
});

describe('routing: ranking and matching (pure)', () => {
  const targets = [T('openai', 'gpt-4o'), T('groq', 'llama'), T('anthropic', 'haiku')];

  it('cheapest orders by price, unknown prices last', () => {
    const price: Record<string, number | null> = { 'openai:gpt-4o': 5, 'groq:llama': 1, 'anthropic:haiku': null };
    const r = rankTargets('cheapest', targets, [], { estimateCost: t => price[`${t.provider}:${t.model}`], latencyMs: () => null });
    assert.deepEqual(r.map(t => t.provider), ['groq', 'openai', 'anthropic']);
  });

  it('fastest orders by observed latency, unobserved last', () => {
    const lat: Record<string, number> = { 'openai:gpt-4o': 900, 'anthropic:haiku': 300 };
    const r = rankTargets('fastest', targets, [], { estimateCost: () => null, latencyMs: t => lat[`${t.provider}:${t.model}`] ?? null });
    assert.deepEqual(r.map(t => t.provider), ['anthropic', 'openai', 'groq']);
  });

  it('policy strategy drops providers the key may not use; fallback keeps order', () => {
    const deps = { estimateCost: () => null, latencyMs: () => null };
    assert.deepEqual(rankTargets('policy', targets, ['groq'], deps).map(t => t.provider), ['groq']);
    assert.deepEqual(rankTargets('fallback', targets, ['groq'], deps).map(t => t.provider), ['openai', 'groq', 'anthropic']);
  });

  it('rule matching by model substring, cost center and team', () => {
    const rule = { match: { model: 'gpt', cost_center: 'cc-1', team_id: '7' } } as RoutingRule;
    const auth = baseAuth({ attribution: { teamId: 7n } as any });
    assert.equal(ruleMatches(rule, auth, 'openai:gpt-4o'), true);
    assert.equal(ruleMatches(rule, auth, 'claude-3'), false);
    assert.equal(ruleMatches(rule, baseAuth(), 'gpt-4o'), false);
  });

  it('key failure classification', () => {
    assert.equal(isKeyFailure(new Error('OpenAI rate limit exceeded: x')), true);
    assert.equal(isKeyFailure(new Error('Groq authentication failed: bad')), true);
    assert.equal(isKeyFailure(new Error('OpenAI error (503): down')), true);
    assert.equal(isKeyFailure(new Error('OpenAI error (400): bad request')), false);
  });
});

describe('SmartRouter.route: key-level and provider-level failover', () => {
  const calls: string[] = [];
  const gateway: any = {
    detectProvider: () => 'openai',
    getAvailableProviders: () => ['openai', 'anthropic'],
    async handleChatCompletion(req: any, provider: string, key: string | null) {
      calls.push(`${provider}:${req.model}:${key}`);
      if (key === 'bad-key') throw new Error('OpenAI rate limit exceeded: slow');
      if (provider === 'openai' && key === 'down') throw new Error('OpenAI error (500): boom');
      if (provider === 'openai' && key === 'bad-request') throw new GatewayError('invalid', 400, 'openai');
      return { id: 'x', model: req.model, choices: [], usage: {}, provider, _tokenistt: {} };
    },
  };
  const router = new SmartRouter(gateway, { enableFailover: true });
  const req: any = { model: 'gpt-4o', messages: [] };
  const keysOf = (...ks: (string | null)[]) => async () => ks.map((k, i) => ({ id: null, key: k, label: `k${i}` }));

  it('a rate-limited BYOK key falls through to the next key on the same provider', async () => {
    calls.length = 0;
    const keys = async () => [
      { id: 'key-a', key: 'bad-key', label: 'primary' },
      { id: 'key-b', key: 'good-key', label: 'secondary' },
    ];
    const out: any = await router.route(req, { keys });
    assert.deepEqual(calls, ['openai:gpt-4o:bad-key', 'openai:gpt-4o:good-key']);
    assert.equal(out.provider, 'openai');
  });

  it('a failing non-BYOK key (no id) is not retried; the router moves to the next provider', async () => {
    calls.length = 0;
    await assert.rejects(router.route(req, { keys: keysOf('bad-key') }), /All attempted providers failed/);
    assert.ok(calls.every(c => c.endsWith(':bad-key')));
    assert.equal(calls.filter(c => c.startsWith('openai')).length, 1);
  });

  it('provider error moves to the next provider in the chain with model translation', async () => {
    calls.length = 0;
    const out: any = await router.route(req, { keys: keysOf('down') });
    assert.equal(out.provider, 'anthropic');
    assert.equal(out._tokenistt.failover_used, true);
    assert.equal(calls[0].startsWith('openai:gpt-4o'), true);
  });

  it('client errors (400) are not retried or failed over', async () => {
    calls.length = 0;
    await assert.rejects(router.route(req, { keys: keysOf('bad-request') }), (e: any) => e.statusCode === 400);
    assert.equal(calls.length, 1);
  });

  it('explicit routing-rule candidates are used in order', async () => {
    calls.length = 0;
    const out: any = await router.route(req, {
      candidates: [T('anthropic', 'claude-3-haiku'), T('openai', 'gpt-4o')],
      keys: keysOf('ok'),
    });
    assert.equal(out.provider, 'anthropic');
    assert.equal(out._tokenistt.routed_model, 'claude-3-haiku');
    assert.equal(calls.length, 1);
  });
});

const hasDb = !!process.env.DATABASE_URL;
describe('BYOK + rules against Postgres', { skip: !hasDb && 'DATABASE_URL not set' }, () => {
  const sfx = randomUUID().slice(0, 8);
  let orgId: string;

  before(async () => {
    const pool = getPool();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`BYOK ${sfx}`, `byok-${sfx}`])).rows[0].id;
  });
  after(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM provider_keys WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM routing_rules WHERE organization_id = $1', [orgId]);
  });

  it('returns keys by priority, encrypted at rest, with legacy and default last', async () => {
    await addProviderKey({ organizationId: orgId, provider: 'openai', label: 'secondary', apiKey: 'sk-second', priority: 200 });
    await addProviderKey({ organizationId: orgId, provider: 'openai', label: 'primary', apiKey: 'sk-first', priority: 10 });

    const stored = await getPool().query('SELECT encrypted_key FROM provider_keys WHERE organization_id = $1', [orgId]);
    assert.ok(stored.rows.every(r => !r.encrypted_key.includes('sk-')), 'plaintext key must not be stored');

    const keys = await resolveKeys(baseAuth({ organizationId: BigInt(orgId), realApiKey: 'sk-legacy' }), 'openai');
    assert.deepEqual(keys.map(k => k.key), ['sk-first', 'sk-second', 'sk-legacy', null]);
  });

  it('resolveRoute picks the highest-priority matching rule and orders cheapest first', async () => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO routing_rules (organization_id, name, priority, strategy, match, targets) VALUES
       ($1,'catch-all fallback',200,'fallback','{}',$2),
       ($1,'cheap summaries',10,'cheapest',$3,$4)`,
      [orgId, JSON.stringify([T('openai', 'gpt-4o')]), JSON.stringify({ model: 'gpt' }),
       JSON.stringify([T('openai', 'gpt-4o'), T('openai', 'gpt-4o-mini')])]
    );
    clearRoutingCache();
    const d = await resolveRoute(baseAuth({ organizationId: BigInt(orgId) }), { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } as any);
    assert.equal(d?.rule.name, 'cheap summaries');
    assert.equal(d?.candidates[0].model, 'gpt-4o-mini'); // mini is cheaper than 4o in the catalog
  });

  it('no matching rule returns null (default routing)', async () => {
    const d = await resolveRoute(baseAuth({ organizationId: 987654321n }), { model: 'x', messages: [] } as any);
    assert.equal(d, null);
  });
});
