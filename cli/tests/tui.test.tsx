import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/App.js';
import { gatherLocal, plainStatus, probeGateway, type DashboardData } from '../src/tui/data.js';
import { handleHook } from '../src/agents/hook-main.js';
import { indexProject } from '../src/graph/indexer.js';
import { repoInfo } from '../src/project/git.js';
import { openDatabase } from '../src/store/db.js';
import { initProject } from '../src/store/project.js';
import { fakeGateway, gitRepo, runCli, tempDir } from './helpers.js';
import type { SessionSummary } from '../src/agents/sessions.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const tick = () => new Promise((r) => setTimeout(r, 60));

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  key: 'claude-code:abcdefgh', agent: 'claude-code', id: 'abcdefgh1234', branch: 'main', state: 'active', startedAt: 't', endedAt: null, lastEventAt: 't', durationMs: 754000, endReason: null, task: null, models: ['m1'],
  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 18420, requests: 1 }, cost: { costUsd: null, source: 'unknown' },
  counts: { tasks: 1, filesRead: 0, filesCreated: 0, filesModified: 1, filesDeleted: 0, commands: 0, tools: 0, errors: 2, testsPassed: 1, testsFailed: 0, testsUnknown: 0 },
  files: { read: [], created: [], modified: ['src/a.ts'], deleted: [] }, commands: [], ...over,
});

const data = (over: Partial<DashboardData> = {}): DashboardData => ({
  project: { name: 'demo', id: 'repo_x', root: '/r', branch: 'main', commit: 'abc1234', subject: 'first', privacy: 'name', capturePrompts: false, syncEnabled: false },
  graph: { schemaVersion: '1.0', extractorVersion: 1, repository: { id: 'r', name: 'demo', branch: 'main', commit: 'c' }, generatedAt: '2026-11-02', durationMs: 1, mode: 'full', files: { total: 7, parsed: 7, reused: 0, skipped: 0, parseErrors: 0 }, nodes: { file: 7, function: 3 }, edges: { CALLS: 5 }, links: {}, languages: { typescript: 7 } },
  largest: [{ name: 'src', type: 'directory', nodes: 12 }], mostUsed: [{ name: 'query', type: 'function', dependents: 4, path: 'src/db.ts' }],
  agents: [{ id: 'claude-code', name: 'Claude Code', installed: true, connected: true, state: 'active', verification: 'live' }, { id: 'codex', name: 'OpenAI Codex', installed: false, connected: false, state: 'not connected', verification: 'documented' }],
  sessions: [session(), session({ key: 'k2', id: 'zzzz9999', tokens: null, state: 'ended' })],
  costs: [{ agent: 'Claude Code', sessions: 2, tokens: null, costUsd: null }, { agent: 'OpenAI Codex', sessions: 0, tokens: null, costUsd: null }],
  memory: { total: 3, active: 2, stale: 1, superseded: 0, retired: 0, byCategory: { ARCHITECTURAL_DECISIONS: 1 }, bySource: {}, lastUpdated: '2026-11-02' },
  memories: [{ id: 'm', content: 'Use Postgres', status: 'active' } as never, { id: 'n', content: 'Old fact', status: 'stale' } as never],
  gateway: { state: 'not configured', url: null },
  ...over,
});

describe('dashboard screens', () => {
  it('shows real numbers on the overview, and unknown where there is none', () => {
    const { lastFrame, unmount } = render(<App data={data()} motion={false} />);
    const f = lastFrame() ?? '';
    for (const text of ['demo', 'main', 'abc1234', 'Claude Code', 'active', 'not connected', 'Nodes', '10', 'unknown for some sessions', 'not configured']) assert.ok(f.includes(text), text);
    unmount();
  });
  it('explains empty states, rather than showing zeros as if measured', async () => {
    const empty = data({ graph: null, largest: [], mostUsed: [], sessions: [], memories: [] });
    const { lastFrame, stdin, unmount } = render(<App data={empty} motion={false} />);
    assert.match(lastFrame() ?? '', /Not indexed yet/);
    stdin.write('3');
    await tick();
    assert.match(lastFrame() ?? '', /No sessions recorded yet/);
    stdin.write('6');
    await tick();
    assert.match(lastFrame() ?? '', /Nothing remembered yet/);
    unmount();
  });
  it('navigates every tab by number, arrows and wrap-around', async () => {
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} />);
    const expected: Array<[string, RegExp]> = [['2', /from its documentation only/], ['3', /tokens 18,420/], ['4', /typescript 7/], ['5', /Largest areas/], ['6', /Use Postgres/], ['7', /By agent/], ['8', /enforced by your gateway/], ['9', /Commands kept/], ['1', /Repository/]];
    for (const [key, text] of expected) {
      stdin.write(key);
      await tick();
      assert.match(lastFrame() ?? '', text, key);
    }
    stdin.write('\x1b[D');
    await tick();
    assert.match(lastFrame() ?? '', /Commands kept/, 'left from the first wraps to the last');
    stdin.write('\x1b[C');
    await tick();
    assert.match(lastFrame() ?? '', /Repository/);
    unmount();
  });
  it('selects sessions with up and down, staying in range', async () => {
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} initialTab="Sessions" />);
    assert.match(lastFrame() ?? '', /abcdefgh1234/);
    stdin.write('\x1b[B');
    await tick();
    assert.match(lastFrame() ?? '', /zzzz9999/);
    stdin.write('\x1b[B');
    await tick();
    assert.match(lastFrame() ?? '', /zzzz9999/);
    stdin.write('\x1b[A');
    stdin.write('\x1b[A');
    await tick();
    assert.match(lastFrame() ?? '', /abcdefgh1234/);
    unmount();
  });
  it('labels costs as estimates and shows unknown', async () => {
    const { lastFrame, stdin, unmount } = render(<App data={data()} motion={false} initialTab="Costs" />);
    assert.match(lastFrame() ?? '', /cost unknown/);
    assert.match(lastFrame() ?? '', /not your bill/);
    stdin.write('3');
    await tick();
    assert.match(lastFrame() ?? '', /Cost\s+unknown/);
    unmount();
  });
  it('marks stale memories', () => {
    const { lastFrame, unmount } = render(<App data={data()} motion={false} initialTab="Memory" />);
    assert.match(lastFrame() ?? '', /\? Old fact/);
    unmount();
  });
  it('picks up fresh data, and survives a reload that fails', async () => {
    let calls = 0;
    const reload = async () => { if (++calls === 1) throw new Error('busy'); return data({ project: { ...data().project, branch: 'updated-branch' } }); };
    const { lastFrame, unmount } = render(<App data={data()} motion={false} reload={reload} reloadMs={20} />);
    await new Promise((r) => setTimeout(r, 200));
    assert.match(lastFrame() ?? '', /updated-branch/);
    unmount();
  });
  it('never draws rows over each other when the screen is short, and scrolls to what does not fit', async () => {
    const { lastFrame, stdout, stdin, unmount } = render(<App data={data()} motion={false} />);
    Object.defineProperty(stdout, 'columns', { value: 60, configurable: true });
    Object.defineProperty(stdout, 'rows', { value: 14, configurable: true });
    (stdout as unknown as { emit: (e: string) => void }).emit('resize');
    await tick();
    assert.match(lastFrame() ?? '', /Repository\s+demo/);
    assert.doesNotMatch(lastFrame() ?? '', /Status/, 'below the fold');
    for (let i = 0; i < 25; i++) stdin.write('\x1b[B');
    await tick();
    assert.match(lastFrame() ?? '', /Gateway\s+not configured/);
    unmount();
  });
  it('quits on q', async () => {
    const { stdin, unmount, lastFrame } = render(<App data={data()} motion={false} />);
    stdin.write('q');
    await tick();
    assert.ok(lastFrame() !== undefined);
    unmount();
  });
  it('fits a narrow terminal when resized', async () => {
    const { lastFrame, stdout, unmount } = render(<App data={data()} motion={false} />);
    Object.defineProperty(stdout, 'columns', { value: 60, configurable: true });
    (stdout as unknown as { emit: (e: string) => void }).emit('resize');
    await tick();
    assert.match(lastFrame() ?? '', /1\/9 Overview/);
    unmount();
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
    assert.equal(c?.tokens, null);
    assert.equal(c?.costUsd, null);
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
