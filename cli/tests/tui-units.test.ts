import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hitTest, looksLikeMouseFragment, parseMouse, tabSpans, type Layout } from '../src/tui/mouse.js';
import { cellWidth, cleanLine, truncateCells, wrapCells } from '../src/tui/format.js';
import { foldWeeks, fetchFinops, refreshPricesIfStale, rollupUsage, weekStart, type FinopsRow } from '../src/tui/data.js';
import { SCREENS } from '../src/tui/commands.js';
import { openDatabase } from '../src/store/db.js';
import { findPrice, modelIdCandidates, priceTableFromCatalog, priceUsage, readPrices, sumCosts, describeCost } from '../src/agents/sessions.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeGateway, gitRepo } from './helpers.js';
import { initProject, projectDir } from '../src/store/project.js';
import { repoInfo } from '../src/project/git.js';

describe('mouse reports', () => {
  it('reads wheel turns, clicks and releases, with or without the leading escape', () => {
    assert.deepEqual(parseMouse('\x1b[<64;40;12M').events, [{ kind: 'wheel', direction: 'up', x: 40, y: 12 }]);
    assert.deepEqual(parseMouse('[<65;3;4M').events, [{ kind: 'wheel', direction: 'down', x: 3, y: 4 }]);
    assert.deepEqual(parseMouse('[<0;10;27M').events, [{ kind: 'click', x: 10, y: 27 }]);
    assert.deepEqual(parseMouse('[<0;10;27m').events, [{ kind: 'release', x: 10, y: 27 }]);
  });
  it('ignores drags and other buttons, and takes several reports from one chunk', () => {
    assert.deepEqual(parseMouse('[<32;5;5M').events, [], 'a drag is not a click');
    assert.deepEqual(parseMouse('[<2;5;5M').events, [], 'the right button is not a click');
    const r = parseMouse('[<64;1;1M[<64;1;1Mx');
    assert.equal(r.events.length, 2);
    assert.equal(r.rest, 'x', 'what is typed alongside is kept');
  });
  it('leaves ordinary text alone, and recognises a torn report', () => {
    assert.deepEqual(parseMouse('hello'), { events: [], rest: 'hello' });
    assert.equal(looksLikeMouseFragment('[<64;4'), true);
    assert.equal(looksLikeMouseFragment('[<'), true);
    assert.equal(looksLikeMouseFragment('a[<'), false);
    assert.equal(looksLikeMouseFragment('hello'), false);
  });
  const layout: Layout = { columns: 99, rows: 30, bodyHeight: 24, leftWidth: 41, tabs: tabSpans(SCREENS) };
  it('maps a click to the tab, the prompt or the body it landed on', () => {
    assert.deepEqual(hitTest(layout, 3, 2), { kind: 'tab', name: 'Home' });
    const agents = layout.tabs.find((t) => t.name === 'Agents');
    assert.deepEqual(hitTest(layout, (agents?.from ?? 0) + 1, 2), { kind: 'tab', name: 'Agents' });
    assert.deepEqual(hitTest(layout, 90, 2), { kind: 'none' }, 'past the last tab');
    assert.deepEqual(hitTest(layout, 20, 3 + 24 + 1), { kind: 'prompt', column: 20 });
    assert.equal(hitTest(layout, 20, 3 + 24 - 1).kind, 'body');
    assert.equal(hitTest(layout, 20, 30).kind, 'none', 'the footer does nothing');
    assert.deepEqual(hitTest(layout, 10, 5), { kind: 'body', row: 2, column: 10, panel: 'left' });
    assert.equal((hitTest(layout, 60, 5) as { panel: string }).panel, 'right');
  });
});

describe('text that is safe to draw', () => {
  it('measures cells: wide characters count two, combining marks none', () => {
    assert.equal(cellWidth('abc'), 3);
    assert.equal(cellWidth('日本'), 4);
    assert.equal(cellWidth('é'), 1);
  });
  it('truncates and wraps by cells, never past the width', () => {
    assert.equal(truncateCells('hello world', 6), 'hello~');
    assert.equal(truncateCells('hi', 6), 'hi');
    assert.equal(cellWidth(truncateCells('日本語日本語', 7)) <= 7, true);
    for (const line of wrapCells('the quick brown fox jumps over the lazy dog '.repeat(5), 20)) assert.ok(cellWidth(line) <= 20, line);
    assert.deepEqual(wrapCells('short', 20), ['short']);
    assert.ok(wrapCells('x'.repeat(100), 10).every((l) => l.length <= 10));
  });
  it('keeps what a spinner wrote last, and drops colour codes and control characters', () => {
    assert.equal(cleanLine('\x1b[32m✔\x1b[0m Starting\rViewer running at http://x'), 'Viewer running at http://x');
    assert.equal(cleanLine('a\tb'), 'a  b');
    assert.equal(cleanLine('\x1b[2K\x1b[?25lready\x07'), 'ready');
    assert.equal(cleanLine('\x1b]0;title\x07text'), 'text');
    assert.equal(cleanLine('trailing   '), 'trailing');
    assert.equal(cleanLine('\r\r'), '');
  });
});

describe('prices and costs', () => {
  const row = (model: string | null, input = 1_000_000, output = 0, cacheRead = 0, cacheCreation = 0) => ({ model, input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_creation_tokens: cacheCreation });
  it('finds a model by the id the vendor reports, stripping dates and provider prefixes only to reach an id the table has', () => {
    assert.ok(modelIdCandidates('anthropic/claude-sonnet-4-5-20250929').includes('claude-sonnet-4-5'));
    const table = { 'claude-sonnet-4-5': { input: 3, output: 15 }, 'gpt-4o': { input: 2.5, output: 10 } };
    assert.equal(findPrice(table, 'claude-sonnet-4-5-20250929')?.input, 3);
    assert.equal(findPrice(table, 'anthropic/claude-sonnet-4-5')?.input, 3);
    assert.equal(findPrice(table, 'GPT-4o-2024-08-06')?.input, 2.5, 'a dated id reaches its base, which the table names');
    assert.equal(findPrice(table, 'gpt-4o-latest')?.input, 2.5);
    assert.equal(findPrice(table, 'claude-sonnet')?.input, undefined, 'no family guessing');
    assert.equal(findPrice(table, 'claude-opus-4-5'), undefined);
  });
  it('prices each record by its own model and reports what it could not price', () => {
    const table = { a: { input: 2, output: 4 } };
    const r = priceUsage([row('a', 1_000_000, 500_000), row('b', 3_000, 1_000)], table);
    assert.equal(r.costUsd, null, 'not a total: part of it is unpriced');
    assert.equal(r.knownUsd, 4);
    assert.equal(r.unpricedTokens, 4_000);
    assert.deepEqual(r.unpricedModels, ['b']);
    assert.match(r.note ?? '', /prices\.json/);
    assert.equal(describeCost(r), '~$4.0000 known + 4,000 tokens unpriced');
  });
  it('prices cache reads and writes only where the table has a price for them', () => {
    const noCache = priceUsage([row('a', 0, 0, 1_000_000, 0)], { a: { input: 2, output: 4 } });
    assert.equal(noCache.costUsd, null);
    assert.equal(noCache.unpricedTokens, 1_000_000);
    assert.deepEqual(noCache.unpricedModels, ['a cache reads']);
    const both = priceUsage([row('a', 0, 0, 1_000_000, 1_000_000)], { a: { input: 2, output: 4, cachedInput: 0.2, cacheWrite: 2.5 } });
    assert.equal(both.costUsd, 2.7);
    assert.equal(priceUsage([row('a', 0, 0, 0, 5)], { a: { input: 2, output: 4 } }).unpricedTokens, 5);
  });
  it('adds up costs honestly: complete only if every part is', () => {
    const complete = sumCosts([{ costUsd: 1, source: 'catalog_estimate' }, { costUsd: 2, source: 'catalog_estimate' }]);
    assert.equal(complete.costUsd, 3);
    const part = sumCosts([{ costUsd: 1, source: 'catalog_estimate', knownUsd: 1 }, { costUsd: null, source: 'unknown', knownUsd: 0.5, unpricedTokens: 10, unpricedModels: ['m'] }]);
    assert.equal(part.costUsd, null);
    assert.equal(part.knownUsd, 1.5);
    assert.equal(part.unpricedTokens, 10);
    assert.equal(describeCost({ costUsd: null, source: 'unknown' }), 'unknown');
  });
  it('turns the gateway catalog into prices, leaving out what it does not price', () => {
    const t = priceTableFromCatalog([
      { model: 'm1', input_per_1m: 3, output_per_1m: 15, cached_input_per_1m: 0.3, cache_write_per_1m: 3.75 },
      { model: 'm2', input_per_1m: null, output_per_1m: null },
      { model: 'm3', input_per_1m: 1, output_per_1m: 2 },
    ]);
    assert.deepEqual(Object.keys(t).sort(), ['m1', 'm3']);
    assert.deepEqual(t.m1, { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 });
    assert.deepEqual(t.m3, { input: 1, output: 2 });
  });
  it('reads fetched prices and lets your own file win, with no built-in prices', () => {
    const t = gitRepo({ 'a.ts': 'x' });
    try {
      const { project } = initProject(repoInfo(t.dir)!);
      assert.equal(readPrices(t.dir), undefined, 'nothing is priced until you have prices');
      mkdirSync(join(projectDir(t.dir), 'cache'), { recursive: true });
      writeFileSync(join(projectDir(t.dir), 'cache', 'prices.json'), JSON.stringify({ m1: { input: 3, output: 15 }, m2: { input: 1, output: 1 }, bad: { input: 'x' } }));
      writeFileSync(join(projectDir(t.dir), 'prices.json'), JSON.stringify({ m1: { input: 9, output: 9, cachedInput: 1 }, mine: { input: 5, output: 5 } }));
      const prices = readPrices(t.dir);
      assert.equal(prices?.m1?.input, 9, 'your file wins');
      assert.equal(prices?.m2?.input, 1);
      assert.equal(prices?.mine?.input, 5);
      assert.equal(prices?.bad, undefined, 'a malformed entry is ignored');
      assert.ok(project.config.projectId);
    } finally {
      t.cleanup();
    }
  });
  it('fetches prices from the gateway when there are none, and then leaves them alone for a day', async () => {
    const t = gitRepo({ 'a.ts': 'x' });
    const gw = await fakeGateway({ 'GET /v1/admin/models': { json: [{ provider: 'anthropic', model: 'claude-x', input_per_1m: 3, output_per_1m: 15, cached_input_per_1m: 0.3, cache_write_per_1m: null, requests: 0 }] } });
    try {
      initProject(repoInfo(t.dir)!);
      const cfg = { apiUrl: gw.url, fromEnv: [], hasFile: true, token: 't' } as never;
      assert.equal(await refreshPricesIfStale(cfg, t.dir), 1);
      assert.deepEqual(readPrices(t.dir)?.['claude-x'], { input: 3, output: 15, cachedInput: 0.3 });
      assert.equal(await refreshPricesIfStale(cfg, t.dir), null, 'fresh enough');
      assert.equal(gw.requests.length, 1);
      assert.equal(await refreshPricesIfStale({ apiUrl: 'http://127.0.0.1:9', fromEnv: [], hasFile: true } as never, t.dir, undefined, 0), null, 'no credentials: nothing happens');
    } finally {
      await gw.close();
      t.cleanup();
    }
  });
});

describe('weekly and daily usage', () => {
  const day = (key: string, over: Partial<FinopsRow> = {}): FinopsRow => ({ key, requests: 1, input: 10, output: 5, cached: 1, tokens: 16, costUsd: 1, errors: 0, zeroCost: 0, p95Ms: null, ...over });
  it('puts every day in the Monday-start week it belongs to', () => {
    assert.equal(weekStart('2026-11-02'), '2026-11-02');
    assert.equal(weekStart('2026-11-08'), '2026-11-02', 'Sunday belongs to the week before');
    assert.equal(weekStart('2026-11-09'), '2026-11-09');
    assert.equal(weekStart('2026-01-01'), '2025-12-29', 'across a year end');
    assert.equal(weekStart('2026-11-05T13:00:00Z'), '2026-11-02');
    assert.equal(weekStart('not a date'), 'not a date');
  });
  it('folds days into weeks by summing, and keeps the slowest day as the week\'s latency', () => {
    const weeks = foldWeeks([day('2026-11-08', { p95Ms: 300, zeroCost: 2 }), day('2026-11-02', { p95Ms: 100 }), day('2026-11-09', { costUsd: 5 })]);
    assert.deepEqual(weeks.map((w) => w.key), ['2026-11-02', '2026-11-09']);
    assert.equal(weeks[0]?.requests, 2);
    assert.equal(weeks[0]?.tokens, 32);
    assert.equal(weeks[0]?.costUsd, 2);
    assert.equal(weeks[0]?.p95Ms, 300);
    assert.equal(weeks[0]?.zeroCost, 2);
    assert.equal(weeks[1]?.costUsd, 5);
    assert.deepEqual(foldWeeks([]), []);
  });
  it('reads daily, weekly, model and session rows from the gateway', async () => {
    const gw = await fakeGateway({
      'GET /v1/admin/usage/summary': { json: { rows: [{ key: 'all', requests: 3, total_tokens: '30', cost_usd: '0.5', errors: 1, zero_cost_requests: 0 }] } },
      'GET /v1/admin/budgets': { json: [] },
      'GET /v1/admin/agent-sessions': { json: [{ agent: 'claude-code', session_id: 's1', repository: 'demo', branch: 'main', state: 'ended', started_at: '2026-11-05T10:00:00Z', models: ['m'], tokens: { total: 99 }, cost_usd: null }] },
    });
    try {
      const f = await fetchFinops({ apiUrl: gw.url, fromEnv: [], hasFile: true, token: 't' } as never);
      assert.equal(f.state, 'ok');
      assert.equal(f.sessions[0]?.tokens, 99);
      assert.equal(f.sessions[0]?.costUsd, null, 'unknown stays unknown');
      const q = gw.requests.map((r) => r.path + r.search);
      assert.ok(q.some((p) => /group_by=day/.test(p) && /since=/.test(p)), 'ninety days of daily rows');
      assert.ok(q.some((p) => /group_by=model/.test(p)));
    } finally {
      await gw.close();
    }
  });
  it('rolls local agent usage up by day, week, model and session, each priced on its own records', () => {
    const t = gitRepo({ 'a.ts': 'x' });
    const db = openDatabase(t.dir);
    try {
      const session = db.prepare("INSERT INTO agent_sessions (key, agent, session_id, started_at, last_event_at, status) VALUES (?, 'claude-code', ?, ?, ?, 'ended')");
      session.run('s1', 'aaaaaaaa11', '2026-11-02T08:00:00Z', '2026-11-04T09:00:00Z');
      session.run('s2', 'bbbbbbbb22', '2026-11-09T08:00:00Z', '2026-11-09T09:00:00Z');
      const use = db.prepare('INSERT INTO agent_usage (session_key, request_id, model, at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      use.run('s1', 'r1', 'priced', '2026-11-02T10:00:00Z', 1_000_000, 0, 0, 0);
      use.run('s1', 'r2', 'priced', '2026-11-04T10:00:00Z', 0, 1_000_000, 0, 0); // same session, a later day
      use.run('s1', 'r3', 'mystery', null, 100, 0, 0, 0); // no time of its own: falls back to the session's last event
      use.run('s2', 'r4', 'priced', '2026-11-09T10:00:00Z', 2_000_000, 0, 0, 0);
      const u = rollupUsage(db, { priced: { input: 1, output: 2 } });
      assert.deepEqual(u.day.map((g) => g.key), ['2026-11-09', '2026-11-04', '2026-11-02'], 'newest first, and a long session lands on the days it ran');
      assert.equal(u.day.find((g) => g.key === '2026-11-02')?.cost.costUsd, 1);
      const nov4 = u.day.find((g) => g.key === '2026-11-04');
      assert.equal(nov4?.requests, 2, 'the record with no time of its own joins the last day of its session');
      assert.equal(nov4?.cost.costUsd, null, 'a day with an unpriced model is not given a total');
      assert.equal(nov4?.cost.knownUsd, 2);
      assert.deepEqual(nov4?.cost.unpricedModels, ['mystery']);
      assert.deepEqual(u.week.map((g) => g.key), ['2026-11-09', '2026-11-02']);
      assert.equal(u.week.find((g) => g.key === '2026-11-02')?.total, 2_000_100);
      assert.equal(u.model[0]?.key, 'priced');
      assert.equal(u.model[0]?.cost.costUsd, 5);
      assert.equal(u.model.find((g) => g.key === 'mystery')?.cost.costUsd, null);
      assert.deepEqual(u.session.map((g) => g.label), ['claude-code aaaaaaaa', 'claude-code bbbbbbbb'], 'largest first');
      assert.equal(rollupUsage(db, undefined).day[0]?.cost.costUsd, null, 'with no prices nothing is priced');
    } finally {
      db.close();
      t.cleanup();
    }
  });
});
