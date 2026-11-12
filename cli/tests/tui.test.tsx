import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { App, changes } from '../src/tui/App.js';
import { CLI_COMMANDS, parse } from '../src/tui/commands.js';
import { buildProgram } from '../src/program.js';
import { unicodeSupported } from '../src/tui/theme.js';
import { fetchFinops, gatherLocal, plainStatus, probeGateway, type DashboardData } from '../src/tui/data.js';
import { handleHook } from '../src/agents/hook-main.js';
import { indexProject } from '../src/graph/indexer.js';
import { repoInfo } from '../src/project/git.js';
import { openDatabase } from '../src/store/db.js';
import { initProject } from '../src/store/project.js';
import { fakeGateway, gitRepo, runCli, tempDir } from './helpers.js';
import type { SessionSummary } from '../src/agents/sessions.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const tick = () => new Promise((r) => setTimeout(r, 100));

import { data, session, usage } from './tui-fixtures.js';

const until = async (frame: () => string | undefined, re: RegExp): Promise<void> => { for (let i = 0; i < 60 && !re.test(frame() ?? ''); i++) await new Promise((r) => setTimeout(r, 50)); assert.match(frame() ?? '', re); };
const type = async (stdin: { write: (s: string) => void }, text: string) => { for (const ch of text) { stdin.write(ch); await new Promise((r) => setTimeout(r, 5)); } await tick(); };
const KEY = { tab: '\t', shiftTab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', ctrlK: '\x0b', ctrlL: '\x0c' };

const finops: DashboardData['finops'] = {
  state: 'ok', days: 30, total: { requests: 120, tokens: 90000, costUsd: 12.3456, errors: 2, zeroCost: 3 },
  byModel: [{ key: 'gpt-4o', requests: 100, input: 50000, output: 20000, cached: 10000, tokens: 80000, costUsd: 11, errors: 0, zeroCost: 0, p95Ms: 900 }, { key: 'claude-haiku', requests: 20, input: 6000, output: 3000, cached: 1000, tokens: 10000, costUsd: 1.3456, errors: 2, zeroCost: 3, p95Ms: null }],
  byDay: [{ key: '2026-11-04', requests: 5, input: 1, output: 1, cached: 0, tokens: 2, costUsd: 1, errors: 0, zeroCost: 0, p95Ms: null }, { key: '2026-11-05', requests: 5, input: 1, output: 1, cached: 0, tokens: 2, costUsd: 3, errors: 0, zeroCost: 0, p95Ms: null }],
  byWeek: [{ key: '2026-11-02', requests: 10, input: 2, output: 2, cached: 0, tokens: 4, costUsd: 4, errors: 0, zeroCost: 0, p95Ms: null }],
  sessions: [{ agent: 'claude-code', id: 'sess-aaaa', repository: 'demo', branch: 'main', state: 'ended', startedAt: '2026-11-05T10:00:00Z', models: ['m1'], tokens: 1234, costUsd: null }],
  budgets: [{ id: 'b', scope: 'team', name: 'Platform', capUsd: 500, period: 'monthly', mode: 'hard_cap', active: true }],
};

describe('terminal application', () => {
  it('opens on Home with real numbers, a prompt and an activity feed', () => {
    const { lastFrame, unmount } = render(<App data={data()} motion={false} />);
    const f = lastFrame() ?? '';
    for (const text of ['Tokenistt', 'demo', 'main', 'abc1234', 'Claude Code', 'active', 'not connected', 'Activity', 'Ready. 2 sessions', 'type / for commands']) assert.ok(f.includes(text), text);
    unmount();
  });
  it('switches screens with Tab and Shift+Tab, wrapping round', async () => {
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} />);
    const expected = [/from docs only/, /Use Postgres/, /Largest areas/, /Nano is not built yet/, /Gateway spend/];
    for (const re of expected) { stdin.write(KEY.tab); await until(lastFrame, re); }
    stdin.write(KEY.tab); await until(lastFrame, /Activity/);
    stdin.write(KEY.shiftTab); await until(lastFrame, /Gateway spend/);
    unmount();
  });
  it('runs slash commands typed at the prompt, and explains unknown ones', async () => {
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} />);
    await type(stdin, '/agents'); stdin.write(KEY.enter); await tick();
    assert.match(lastFrame() ?? '', /abcdefgh1234|abcdefgh/);
    await type(stdin, '/nope'); stdin.write(KEY.enter); await tick();
    assert.match(lastFrame() ?? '', /Unknown command: \/nope/);
    unmount();
  });
  it('answers plain text from the injected search, and says when nothing matches', async () => {
    const search = (q: string) => (q === 'query' ? ['function   query  src/db.ts:3'] : []);
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} search={search} />);
    await type(stdin, 'query'); stdin.write(KEY.enter); await tick();
    assert.match(lastFrame() ?? '', /function\s+query\s+src\/db\.ts:3/);
    await type(stdin, 'zzz'); stdin.write(KEY.enter); await tick();
    assert.match(lastFrame() ?? '', /Nothing found for "zzz"/);
    unmount();
  });
  it('opens the command palette with Ctrl+K, filters, and runs the choice', async () => {
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} />);
    stdin.write(KEY.ctrlK); await tick();
    assert.match(lastFrame() ?? '', /\/finops/);
    await type(stdin, 'fin');
    assert.doesNotMatch(lastFrame() ?? '', /\/agents/);
    stdin.write(KEY.enter); await tick();
    assert.match(lastFrame() ?? '', /Gateway spend/);
    stdin.write(KEY.ctrlK); await tick();
    stdin.write(KEY.esc); await tick();
    assert.doesNotMatch(lastFrame() ?? '', /No matching command|\/refresh/);
    unmount();
  });
  it('selects sessions and memories with up and down, staying in range', async () => {
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} initialScreen="Agents" />);
    assert.match(lastFrame() ?? '', /Session abcdefgh1234/);
    stdin.write(KEY.down); await tick();
    assert.match(lastFrame() ?? '', /Session zzzz9999/);
    stdin.write(KEY.down); await tick();
    assert.match(lastFrame() ?? '', /Session zzzz9999/);
    stdin.write(KEY.up); stdin.write(KEY.up); stdin.write(KEY.up); await tick();
    assert.match(lastFrame() ?? '', /Session abcdefgh1234/);
    unmount();
  });
  it('explains empty states, rather than showing zeros as if measured', () => {
    const empty = data({ graph: null, largest: [], mostUsed: [], sessions: [], memories: [] });
    for (const [s, re] of [['Graph', /Not indexed yet/], ['Agents', /No sessions recorded yet/], ['Memory', /Nothing remembered yet/]] as const) {
      const { lastFrame, unmount } = render(<App data={empty} motion={false} initialScreen={s} />);
      assert.match(lastFrame() ?? '', re, s);
      unmount();
    }
  });
  it('marks stale memories and labels local costs as estimates', () => {
    const m = render(<App data={data()} motion={false} initialScreen="Memory" />);
    assert.match(m.lastFrame() ?? '', /\? Old fact|\?\s+Old fact/);
    m.unmount();
    const f = render(<App data={data()} motion={false} initialScreen="FinOps" />);
    assert.match(f.lastFrame() ?? '', /not your bill/);
    assert.match(f.lastFrame() ?? '', /No gateway configured/);
    f.unmount();
  });
  it('shows gateway spend, models and budgets, and flags unpriced requests', () => {
    const d = data({ gateway: { state: 'connected', url: 'http://gw' }, finops });
    const { lastFrame, unmount } = render(<App data={d} motion={false} initialScreen="FinOps" />);
    const f = lastFrame() ?? '';
    for (const t of ['$12.35', '120 requests', 'Platform', 'hard_cap', 'no catalog price']) assert.ok(f.includes(t), t);
    unmount();
  });
  it('says why spend is missing instead of showing zero', () => {
    const d = data({ gateway: { state: 'connected', url: 'http://gw' }, finops: { state: 'no credentials', detail: 'Run tokenistt login', days: 30, total: null, byModel: [], byDay: [], byWeek: [], sessions: [], budgets: [] } });
    const { lastFrame, unmount } = render(<App data={d} motion={false} initialScreen="FinOps" />);
    assert.match(lastFrame() ?? '', /No management credentials/);
    unmount();
  });
  it('streams command output when motion is on, and clears with Ctrl+L', async () => {
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion search={() => ['one', 'two']} />);
    await type(stdin, 'x'); stdin.write(KEY.enter);
    await new Promise((r) => setTimeout(r, 400));
    assert.match(lastFrame() ?? '', /two/);
    stdin.write(KEY.ctrlL); await tick();
    assert.match(lastFrame() ?? '', /Quiet so far/);
    unmount();
  });
  it('picks up fresh data and narrates the change, and survives a failed reload', async () => {
    let calls = 0;
    const next = data({ sessions: [session(), session({ key: 'k2', id: 'zzzz9999', state: 'active' }), session({ key: 'k3', id: 'newone123' })] });
    const reload = async () => { if (++calls === 1) throw new Error('busy'); return next; };
    const { lastFrame, unmount } = render(<App data={data()} motion={false} reload={reload} reloadMs={20} />);
    await new Promise((r) => setTimeout(r, 250));
    assert.match(lastFrame() ?? '', /newone12 started/);
    assert.match(lastFrame() ?? '', /zzzz9999 is now active/);
    unmount();
  });
  it('describes changes only when something really changed', () => {
    assert.deepEqual(changes(data(), data()), []);
  });
  it('fits a short, narrow terminal without overflowing', async () => {
    const { lastFrame, stdout, unmount } = render(<App data={data()} motion={false} />);
    Object.defineProperty(stdout, 'columns', { value: 60, configurable: true });
    Object.defineProperty(stdout, 'rows', { value: 14, configurable: true });
    (stdout as unknown as { emit: (e: string) => void }).emit('resize');
    await tick();
    const lines = (lastFrame() ?? '').split('\n');
    assert.ok(lines.length <= 14, `${lines.length} rows`);
    assert.ok(lines.every((l) => l.length <= 60), 'no line wider than the terminal');
    assert.match(lastFrame() ?? '', /Activity/);
    unmount();
  });
  it('draws in plain ASCII where unicode is not safe', () => {
    const { lastFrame, unmount } = render(<App data={data()} motion={false} unicode={false} />);
    assert.doesNotMatch(lastFrame() ?? '', /[^\x00-\x7f]/);
    unmount();
  });
  it('detects unicode support, including legacy Windows consoles', () => {
    assert.equal(unicodeSupported({ WT_SESSION: 'x' }, 'win32'), true);
    assert.equal(unicodeSupported({}, 'win32'), false);
    assert.equal(unicodeSupported({ TERM: 'xterm-256color' }, 'linux'), true);
    assert.equal(unicodeSupported({ TERM: 'dumb' }, 'linux'), false);
    assert.equal(unicodeSupported({ TOKENISTT_ASCII: '1', WT_SESSION: 'x' }, 'win32'), false);
  });
  it('parses commands, completing prefixes', () => {
    assert.deepEqual(parse('/fin'), { kind: 'screen', screen: 'FinOps' });
    assert.deepEqual(parse('/search a b'), { kind: 'search', query: 'a b' });
    assert.deepEqual(parse('how does auth work'), { kind: 'search', query: 'how does auth work' });
    assert.equal(parse('/search').kind, 'unknown');
    assert.equal(parse('   ').kind, 'none');
  });
});


describe('typing real commands at the prompt', () => {
  it('knows every CLI command, so none is mistaken for a search', () => {
    assert.deepEqual([...CLI_COMMANDS].sort(), buildProgram().commands.map((c) => c.name()).sort());
  });
  it('runs real commands, with or without the program name', () => {
    assert.deepEqual(parse('graph --open'), { kind: 'cli', args: ['graph', '--open'] });
    assert.deepEqual(parse('tokenistt map'), { kind: 'cli', args: ['map'] });
    assert.deepEqual(parse('tokensitt map'), { kind: 'cli', args: ['map'] });
    assert.deepEqual(parse('doctor --json'), { kind: 'cli', args: ['doctor', '--json'] });
    assert.deepEqual(parse('graph'), { kind: 'screen', screen: 'Graph' });
  });
  it('shows help for help, --help and typos of it', () => {
    for (const t of ['help', '--help', '-h', '?', 'tokenistt --help']) assert.deepEqual(parse(t), { kind: 'help' }, t);
    assert.deepEqual(parse('--heelp'), { kind: 'suggest', typed: '--heelp', suggestion: '--help' });
  });
  it('suggests the command for a typo, and leaves real questions as searches', () => {
    assert.deepEqual(parse('grph'), { kind: 'suggest', typed: 'grph', suggestion: 'graph' });
    assert.deepEqual(parse('mapp'), { kind: 'suggest', typed: 'mapp', suggestion: 'map' });
    assert.equal(parse('how does login work').kind, 'search');
    assert.equal(parse('AuthService').kind, 'search');
  });
  it('sends commands that need their own terminal there instead of hanging', () => {
    assert.equal(parse('login').kind, 'terminal');
    assert.equal(parse('watch').kind, 'terminal');
  });
  it('hands the terminal over for interactive commands and keeps the rest in the app', async () => {
    const calls: string[][] = [];
    const first = render(<App data={data()} motion={false} handOff={(a) => calls.push(a)} />);
    await type(first.stdin, 'login'); first.stdin.write(KEY.enter); await tick();
    first.unmount();
    const second = render(<App data={data()} motion={false} handOff={(a) => calls.push(a)} />);
    await type(second.stdin, 'setup --yes'); second.stdin.write(KEY.enter); await tick();
    second.unmount();
    assert.deepEqual(calls, [['login'], ['setup', '--yes']]);
    const third = render(<App data={data()} motion={false} handOff={(a) => calls.push(a)} />);
    await type(third.stdin, 'mcp'); third.stdin.write(KEY.enter); await tick();
    assert.equal(calls.length, 2, 'mcp is a server for another program, so it stays a hint');
    assert.match(third.lastFrame() ?? '', /needs a terminal of its own/);
    third.unmount();
  });
  it('runs a command in the app, streams its output and lets Esc stop it', async () => {
    let stopped = false;
    let finish: (c: number | null) => void = () => undefined;
    const exec = (args: string[], on: (l: string) => void) => {
      on('viewer at http://127.0.0.1:1 for ' + args.join(' '));
      return { done: new Promise<number | null>((r) => { finish = r; }), stop: () => { stopped = true; finish(null); } };
    };
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} exec={exec} />);
    await type(stdin, 'graph --open'); stdin.write(KEY.enter);
    await until(lastFrame, /viewer at http:\/\/127\.0\.0\.1:1 for graph --open/);
    assert.match(lastFrame() ?? '', /running: graph --open/);
    stdin.write(KEY.esc);
    await until(lastFrame, /stopped/);
    assert.equal(stopped, true);
    assert.doesNotMatch(lastFrame() ?? '', /running:/);
    unmount();
  });
  it('opens a help screen listing keys and commands, and closes it with Esc', async () => {
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} />);
    await type(stdin, '--help'); stdin.write(KEY.enter);
    await until(lastFrame, /How to use this/);
    assert.match(lastFrame() ?? '', /graph --open/);
    stdin.write(KEY.esc);
    await until(lastFrame, /Activity/);
    unmount();
  });
  it('prefills the suggestion after a typo', async () => {
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} />);
    await type(stdin, 'grph'); stdin.write(KEY.enter);
    await until(lastFrame, /Did you mean "graph"/);
    assert.match(lastFrame() ?? '', /› graph/);
    unmount();
  });
});

describe('gateway spend', () => {
  it('reads usage and budgets from the management API', async () => {
    const gw = await fakeGateway({
      'GET /v1/admin/usage/summary': { json: { rows: [{ key: 'all', requests: 3, total_tokens: '30', cost_usd: '0.5', errors: 1, zero_cost_requests: 0 }] } },
      'GET /v1/admin/budgets': { json: [{ id: 'b1', scope_type: 'team', name: null, cap_usd: '100.00', period: 'monthly', enforcement_mode: 'alert_only', is_active: true }] },
    });
    try {
      const f = await fetchFinops({ apiUrl: gw.url, fromEnv: [], hasFile: true, token: 't' } as never);
      assert.equal(f.state, 'ok');
      assert.equal(f.total?.costUsd, 0.5);
      assert.equal(f.budgets[0]?.capUsd, 100);
    } finally {
      await gw.close();
    }
  });
  it('reports missing credentials and failures instead of throwing', async () => {
    assert.equal((await fetchFinops({ apiUrl: 'http://127.0.0.1:9', fromEnv: [], hasFile: true } as never)).state, 'no credentials');
    assert.equal((await fetchFinops({ apiUrl: 'http://127.0.0.1:9', fromEnv: [], hasFile: true, token: 't' } as never)).state, 'error');
  });
});

describe('dashboard data', () => {
  it('gathers from real sources, and a sum with an unknown part is unknown', async () => {
    const t = gitRepo({ 'a.ts': 'export function a() {}' });
    const home = tempDir();
    cleanups.push(t.cleanup, home.cleanup);
    const { project } = initProject(repoInfo(t.dir)!);
    const db = openDatabase(t.dir);
    cleanups.push(() => db.close());
    assert.equal(gatherLocal(project, db, home.dir).graph, null);
    await indexProject(project, db);
    handleHook('codex', JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', cwd: t.dir, source: 'startup' }));
    const d = gatherLocal(project, db, home.dir);
    assert.equal(d.graph?.files.total, 1);
    assert.equal(d.sessions.length, 1);
    assert.equal(d.agents.find((a) => a.id === 'codex')?.state, 'active');
    const c = d.costs.find((x) => x.agent === 'OpenAI Codex');
    assert.equal(c?.sessions, 1);
    assert.equal(c?.tokens, 0);
    assert.equal(c?.unreportedSessions, 1, 'a session with no usage report is counted, not summed as zero');
    assert.equal(c?.cost.costUsd, null);
  });
  it('probes the gateway with nothing but a health check, and never throws', async () => {
    const base = { apiUrl: 'http://127.0.0.1:9', fromEnv: [], hasFile: true };
    assert.equal((await probeGateway({ ...base, hasFile: false })).state, 'not configured');
    assert.equal((await probeGateway(base)).state, 'unreachable');
    const gw = await fakeGateway({ 'GET /health': { json: { status: 'healthy' } } });
    try {
      assert.equal((await probeGateway({ ...base, apiUrl: gw.url })).state, 'connected');
      assert.deepEqual(gw.requests.map((r) => r.path), ['/health']);
    } finally {
      await gw.close();
    }
  });
  it('writes a plain status with no control codes', () => {
    const s = plainStatus(data());
    assert.match(s, /10 nodes, 5 relationships/);
    assert.doesNotMatch(s, /\x1b/);
  });
});

describe('bare tokenistt (end to end, not a terminal)', () => {
  it('prints status and exits, in a set-up repo', () => {
    const t = gitRepo({ 'a.ts': 'x' });
    cleanups.push(t.cleanup);
    writeFileSync(join(t.dir, 'b.ts'), 'y');
    runCli(t.dir, ['init']);
    const r = runCli(t.dir, []);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Graph:\s+not built/);
    assert.doesNotMatch(r.out + r.err, /\x1b/);
    assert.equal(JSON.parse(runCli(t.dir, ['--json']).out).project.name.length > 0, true);
  });
  it('shows help outside a project', () => {
    const t = gitRepo({ 'a.ts': 'x' });
    cleanups.push(t.cleanup);
    const r = runCli(t.dir, []);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Usage: tokenistt/);
    assert.match(r.out, /tokenistt init/);
  });
});
