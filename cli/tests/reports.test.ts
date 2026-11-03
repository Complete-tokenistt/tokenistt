import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findOptimizations, type ModelInfo, type UsageRow } from '../src/services/optimize.js';
import { fakeGateway, gitRepo, runCli } from './helpers.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

const row = (over: Partial<UsageRow> = {}): UsageRow => ({ key: 'big', requests: 100, input_tokens: '1000', output_tokens: '1000', cached_tokens: '0', cost_usd: '90', errors: 0, zero_cost_requests: 0, ...over });
const CATALOG: ModelInfo[] = [
  { provider: 'x', model: 'big', input_per_1m: 10, output_per_1m: 30 },
  { provider: 'x', model: 'small', input_per_1m: 1, output_per_1m: 3 },
  { provider: 'y', model: 'other-provider', input_per_1m: 0.1, output_per_1m: 0.1 },
  { provider: 'x', model: 'unpriced', input_per_1m: null, output_per_1m: null },
];

describe('optimize rules', () => {
  it('suggests a cheaper model, with a range and a trade-off, staying within the provider', () => {
    const f = findOptimizations([row()], CATALOG).find((x) => x.rule === 'cheaper-model');
    assert.match(f?.title ?? '', /might suit small/);
    assert.match(f?.tradeoff ?? '', /Quality may drop/);
    assert.ok(Math.abs((f?.savingsUsd?.low ?? 0) - 20.25) < 0.001);
    assert.ok(Math.abs((f?.savingsUsd?.high ?? 0) - 60.75) < 0.001);
  });
  it('gives no savings figure without prices at both ends', () => {
    assert.equal(findOptimizations([row()], [{ provider: 'x', model: 'big', input_per_1m: null, output_per_1m: null }, CATALOG[1]!]).some((f) => f.rule === 'cheaper-model'), false);
    assert.equal(findOptimizations([row()], [CATALOG[0]!, CATALOG[3]!]).some((f) => f.savingsUsd), false);
  });
  it('stays quiet on small samples and small spend', () => {
    assert.deepEqual(findOptimizations([row({ requests: 5 })], CATALOG), []);
    assert.equal(findOptimizations([row({ cost_usd: '1' }), row({ key: 'small', cost_usd: '99' })], CATALOG).some((f) => f.title.includes('big')), false);
  });
  it('flags missing prices, high errors and uncached large prompts, with evidence', () => {
    assert.match(findOptimizations([row({ zero_cost_requests: 7 })], [])[0]?.evidence ?? '', /7 of 100/);
    assert.match(findOptimizations([row({ errors: 20 })], [])[0]?.title ?? '', /fails 20%/);
    const cache = findOptimizations([row({ input_tokens: '500000' })], []).find((f) => f.rule === 'no-caching');
    assert.equal(cache?.confidence, 'low');
    assert.equal(findOptimizations([row({ input_tokens: '500000', cached_tokens: '400000' })], []).some((f) => f.rule === 'no-caching'), false);
  });
  it('puts firmer findings first, and handles nothing', () => {
    const order = findOptimizations([row({ input_tokens: '500000', errors: 20 })], CATALOG).map((f) => f.confidence);
    assert.deepEqual(order, [...order].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)));
    assert.deepEqual(findOptimizations([], []), []);
  });
});

/** The fake gateway runs in this process, so the CLI has to run without blocking it. */
function run(cwd: string, args: string[], env: Record<string, string>, stdin = ''): Promise<{ code: number; out: string; err: string }> {
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', tsx, main, ...args], { cwd, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NO_COLOR: '1', TOKENISTT_CONFIG_DIR: join(cwd, '.test-config'), ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    p.stdin.end(stdin);
  });
}

const SUMMARY = { group_by: 'model', since: '2026-10-01T00:00:00Z', until: '2026-11-01T00:00:00Z', rows: [{ key: 'big', requests: 100, input_tokens: '1000', output_tokens: '500', cached_tokens: '0', cost_usd: '90.5', errors: 2, zero_cost_requests: 3 }] };

async function env() {
  const t = gitRepo({ 'a.ts': 'x' });
  const gw = await fakeGateway({
    'GET /v1/admin/usage/summary': { json: SUMMARY },
    'GET /v1/admin/models': { json: [{ provider: 'x', model: 'big', requests: 100, input_per_1m: 10, output_per_1m: 30, cached_input_per_1m: 1, cache_write_per_1m: 12 }, { provider: 'x', model: 'small', requests: 0, input_per_1m: 1, output_per_1m: 3, cached_input_per_1m: null, cache_write_per_1m: null }, { provider: 'x', model: 'free', requests: 0, input_per_1m: null, output_per_1m: null }] },
    'GET /v1/admin/provider-keys': { json: [{ id: 'k1', provider: 'openai', label: 'main', priority: 1, status: 'active' }] },
    'POST /v1/admin/provider-keys': { status: 201, json: { id: 'k2' } },
    'DELETE /v1/admin/provider-keys/k1': { json: {} },
    'GET /v1/admin/policies': { json: [{ id: 'p1', name: 'existing', is_enabled: true, actions: { effect: 'block' }, conditions: { model: 'x' } }] },
    'POST /v1/admin/policies': { status: 201, json: { id: 'p2' } },
    'POST /v1/admin/policies/test': (r) => ({ json: JSON.parse(r.body).model === 'bad' ? { allowed: false, code: 'policy_violation', reason: 'no', matched_policy: 'existing', model_after_policies: 'bad' } : { allowed: true, code: null, reason: null, matched_policy: null, model_after_policies: JSON.parse(r.body).model } }),
  });
  cleanups.push(t.cleanup, () => gw.close());
  return { t, gw, e: { TOKENISTT_API_URL: gw.url, TOKENISTT_ADMIN_SECRET: 'operator-secret', TOKENISTT_ORG_ID: '1' } };
}

describe('reports (end to end, against a fake gateway)', () => {
  it('usage and cost report real numbers and warn about unpriced requests', async () => {
    const { t, gw, e } = await env();
    const r = await run(t.dir, ['cost', '--by', 'model', '--days', '7'], e);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\$90\.5000/);
    assert.match(r.err, /total is understated/);
    assert.match(gw.requests[0]?.path ?? '', /usage\/summary/);
    assert.match((await run(t.dir, ['usage', '--csv'], e)).out, /^provider,requests/);
    assert.equal((await run(t.dir, ['usage', '--by', 'nonsense'], e)).code, 2);
    assert.equal(JSON.parse((await run(t.dir, ['usage', '--json'], e)).out).rows[0].requests, 100);
  });
  it('lists agent sessions separately, labelled as not spend', async () => {
    const { t, e } = await env();
    assert.equal(runCli(t.dir, ['init']).code, 0);
    const { handleHook } = await import('../src/agents/hook-main.js');
    handleHook('codex', JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', cwd: t.dir, source: 'startup' }));
    const r = await run(t.dir, ['cost'], e);
    assert.match(r.out, /Coding agents in this repository/);
    assert.match(r.out, /Not in the totals above/);
    assert.match(r.out, /codex\s+1\s+unknown\s+unknown/);
  });
  it('models lists the catalog, and --refresh saves only prices it has', async () => {
    const { t, e } = await env();
    assert.match((await run(t.dir, ['models'], e)).out, /free\s+unknown\s+unknown/);
    assert.equal((await run(t.dir, ['models', '--refresh'], e)).code, 2, 'needs a project');
    runCli(t.dir, ['init']);
    assert.equal((await run(t.dir, ['models', '--refresh'], e)).code, 0);
    const prices = JSON.parse(readFileSync(join(t.dir, '.tokenistt', 'cache', 'prices.json'), 'utf8'));
    assert.deepEqual(prices.big, { input: 10, output: 30, cachedInput: 1, cacheWrite: 12 });
    assert.deepEqual(prices.small, { input: 1, output: 3 });
    assert.equal(prices.free, undefined);
  });
  it('providers takes a key on stdin only, and never prints it', async () => {
    const { t, gw, e } = await env();
    assert.match((await run(t.dir, ['providers'], e)).out, /openai/);
    const added = await run(t.dir, ['providers', 'add', 'openai', '--label', 'x'], e, 'sk-secret-key-value');
    assert.equal(added.code, 0, added.err);
    assert.doesNotMatch(added.out + added.err, /sk-secret/);
    assert.equal(JSON.parse(gw.requests.find((q) => q.method === 'POST')?.body ?? '{}').api_key, 'sk-secret-key-value');
    assert.equal((await run(t.dir, ['providers', 'add', 'openai'], e, '')).code, 2);
    assert.equal((await run(t.dir, ['providers', 'remove', 'k1'], e)).code, 0);
  });
  it('policy test exits 5 when stopped, and 0 when allowed', async () => {
    const { t, e } = await env();
    const stopped = await run(t.dir, ['policy', 'test', '--model', 'bad'], e);
    assert.equal(stopped.code, 5);
    assert.match(stopped.out, /Stopped: policy_violation/);
    assert.equal((await run(t.dir, ['policy', 'test', '--model', 'ok'], e)).code, 0);
    assert.match((await run(t.dir, ['policy'], e)).out, /existing/);
  });
  it('policy apply shows a plan first, creates only new names, and rejects a bad file', async () => {
    const { t, gw, e } = await env();
    const file = join(t.dir, 'p.yaml');
    writeFileSync(file, 'policies:\n  - name: existing\n    actions: { effect: block }\n  - name: fresh\n    conditions: { model: gpt-4o }\n    actions: { effect: block, message: no }\n');
    const plan = await run(t.dir, ['policy', 'apply', file], e);
    assert.match(plan.out, /Would create: fresh/);
    assert.match(plan.out, /unchanged: existing/);
    assert.equal(gw.requests.some((q) => q.method === 'POST'), false);
    assert.equal((await run(t.dir, ['policy', 'apply', file, '--yes'], e)).code, 0);
    const posts = gw.requests.filter((q) => q.method === 'POST').map((q) => JSON.parse(q.body).name);
    assert.deepEqual(posts, ['fresh']);
    writeFileSync(file, 'policies:\n  - name: x\n    actions: { effect: explode }\n');
    assert.equal((await run(t.dir, ['policy', 'apply', file], e)).code, 2);
    assert.equal((await run(t.dir, ['policy', 'apply', join(t.dir, 'missing.yaml')], e)).code, 2);
  });
  it('optimize explains itself, and changes nothing', async () => {
    const { t, gw, e } = await env();
    const r = await run(t.dir, ['optimize'], e);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /big has no catalog price|might suit small/);
    assert.match(r.out, /Trade-off/);
    assert.equal(gw.requests.every((q) => q.method === 'GET'), true);
  });
  it('asks for credentials when there are none, and stays exit 4 offline', async () => {
    const t = gitRepo({ 'a.ts': 'x' });
    cleanups.push(t.cleanup);
    assert.equal((await run(t.dir, ['cost'], { TOKENISTT_API_URL: 'http://127.0.0.1:9' })).code, 3);
    assert.equal((await run(t.dir, ['cost'], { TOKENISTT_API_URL: 'http://127.0.0.1:9', TOKENISTT_ADMIN_SECRET: 'x', TOKENISTT_ORG_ID: '1' })).code, 4);
    assert.equal(existsSync(join(t.dir, '.tokenistt')), false);
  });
});
