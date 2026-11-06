import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleHook } from '../src/agents/hook-main.js';
import { compareSessions, findSession, ingestUsage, listSessions, priceUsage, refresh, sessionState, sessionsForPath, summarize } from '../src/agents/sessions.js';
import { formatCost, formatDuration, formatTokens } from '../src/commands/sessions.js';
import { eventLine, renderFrame } from '../src/commands/watch.js';
import { repoInfo } from '../src/project/git.js';
import { openDatabase } from '../src/store/db.js';
import { initProject } from '../src/store/project.js';
import { gitRepo, runCli } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function setup() {
  const t = gitRepo({ 'a.ts': 'x', 'b.ts': 'y' });
  cleanups.push(t.cleanup);
  initProject(repoInfo(t.dir)!);
  const db = openDatabase(t.dir);
  cleanups.push(() => db.close());
  return { t, db };
}

const T0 = new Date('2026-11-02T10:00:00Z');
const later = (min: number) => new Date(T0.getTime() + min * 60_000);

function claude(dir: string, name: string, extra: Record<string, unknown> = {}, session = 'aaaa1111', now = T0) {
  handleHook('claude-code', JSON.stringify({ session_id: session, hook_event_name: name, cwd: dir, ...extra }), now);
}
const usageLine = (id: string, input: number, output: number, read = 0, write = 0, model = 'claude-x') =>
  `${JSON.stringify({ type: 'assistant', requestId: id, timestamp: 't', message: { model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write } } })}\n`;

function realistic(dir: string, session = 'aaaa1111') {
  const transcript = join(dir, '.tokenistt', 'cache', `${session}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, usageLine('r1', 10, 5, 100, 20) + usageLine('r1', 10, 50, 100, 20) + usageLine('r2', 2, 3, 200, 0));
  claude(dir, 'SessionStart', { source: 'startup', transcript_path: transcript }, session, T0);
  claude(dir, 'UserPromptSubmit', { prompt_id: 'p1' }, session, later(1));
  claude(dir, 'PostToolUse', { tool_name: 'Read', tool_use_id: 'a', tool_input: { file_path: join(dir, 'a.ts') } }, session, later(2));
  claude(dir, 'PostToolUse', { tool_name: 'Edit', tool_use_id: 'b', tool_input: { file_path: join(dir, 'a.ts') } }, session, later(3));
  claude(dir, 'PostToolUse', { tool_name: 'Write', tool_use_id: 'c', tool_input: { file_path: join(dir, 'new.ts') }, tool_response: { type: 'create' } }, session, later(4));
  claude(dir, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'd', tool_input: { command: 'npm test' } }, session, later(5));
  claude(dir, 'PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'e', tool_input: { command: 'npm test' } }, session, later(6));
  claude(dir, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'f', tool_input: { command: 'git status' } }, session, later(7));
  claude(dir, 'PostToolUseFailure', { tool_name: 'Edit', tool_use_id: 'g' }, session, later(8));
  claude(dir, 'PostToolUse', { tool_name: 'Grep', tool_use_id: 'h' }, session, later(9));
  claude(dir, 'SessionEnd', { reason: 'other' }, session, later(10));
  return transcript;
}

describe('session state', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  const at = (min: number) => new Date(now - min * 60_000).toISOString();
  it('goes from active to idle to inactive as it goes quiet, and an end event wins', () => {
    assert.equal(sessionState({ status: 'active', last_event_at: at(1) }, now), 'active');
    assert.equal(sessionState({ status: 'active', last_event_at: at(10) }, now), 'idle');
    assert.equal(sessionState({ status: 'active', last_event_at: at(60) }, now), 'inactive');
    assert.equal(sessionState({ status: 'ended', last_event_at: at(1) }, now), 'ended');
  });
});

describe('summaries from real events', () => {
  it('adds up activity, dedupes files, and measures duration', () => {
    const { t, db } = setup();
    realistic(t.dir);
    refresh(t.dir, db);
    const s = summarize(db, findSession(db, 'aaaa'), later(100).getTime());
    assert.equal(s.state, 'ended');
    assert.equal(s.durationMs, 10 * 60_000);
    assert.deepEqual(s.files, { read: ['a.ts'], created: ['new.ts'], modified: ['a.ts'], deleted: [] });
    assert.deepEqual(s.counts, { tasks: 1, filesRead: 1, filesCreated: 1, filesModified: 1, filesDeleted: 0, commands: 3, tools: 1, errors: 1, testsPassed: 1, testsFailed: 1, testsUnknown: 0 });
    assert.deepEqual(s.commands, [{ command: 'npm test', count: 2 }, { command: 'git status', count: 1 }]);
    assert.deepEqual(s.models, ['claude-x']);
  });
  it('counts each API request once, using its final numbers', () => {
    const { t, db } = setup();
    realistic(t.dir);
    refresh(t.dir, db);
    const s = summarize(db, findSession(db, 'aaaa'), later(100).getTime());
    assert.deepEqual(s.tokens, { input: 12, output: 53, cacheRead: 300, cacheCreation: 20, total: 385, requests: 2 });
  });
  it('reads only new transcript lines, updating a request that was still streaming', () => {
    const { t, db } = setup();
    const file = realistic(t.dir);
    refresh(t.dir, db);
    assert.equal(ingestUsage(db), 0, 'nothing new');
    writeFileSync(file, `${usageLine('r1', 10, 50, 100, 20)}${usageLine('r2', 2, 3, 200, 0)}${usageLine('r2', 2, 99, 200, 0)}${usageLine('r3', 1, 1)}`, { flag: 'w' });
    // A rewritten shorter-or-equal file is left alone until it grows past what was read; real transcripts only append.
    writeFileSync(file, `${usageLine('r4', 1, 1)}`, { flag: 'a' });
    assert.ok(ingestUsage(db) >= 1);
    const s = summarize(db, findSession(db, 'aaaa'), later(100).getTime());
    assert.equal(s.tokens?.requests, 3);
  });
  it('tokens are unknown, not zero, without a transcript or for agents that cannot report', () => {
    const { t, db } = setup();
    claude(t.dir, 'SessionStart', { source: 'startup' }, 'cccc');
    handleHook('codex', JSON.stringify({ session_id: 'dddd', hook_event_name: 'SessionStart', cwd: t.dir, source: 'startup', model: 'gpt-x' }), T0);
    refresh(t.dir, db);
    const now = later(1).getTime();
    assert.equal(summarize(db, findSession(db, 'cccc'), now).tokens, null);
    const codex = summarize(db, findSession(db, 'dddd'), now);
    assert.equal(codex.tokens, null);
    assert.equal(formatTokens(codex.tokens), 'unknown');
    assert.deepEqual(codex.models, ['gpt-x']);
  });
  it('ignores a transcript path that is not transcript-shaped', () => {
    const { t, db } = setup();
    writeFileSync(join(t.dir, 'secret.txt'), usageLine('r', 1, 1));
    claude(t.dir, 'SessionStart', { source: 'startup', transcript_path: join(t.dir, 'secret.txt') }, 'eeee');
    refresh(t.dir, db);
    const s = summarize(db, findSession(db, 'eeee'), later(1).getTime());
    assert.equal(s.tokens?.requests, 0, 'nothing was read from it');
  });
  it('picks up the transcript from any event, for hooks connected partway through a session', () => {
    const { t, db } = setup();
    const file = join(t.dir, '.tokenistt', 'cache', 'mid.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, usageLine('r1', 1, 2));
    claude(t.dir, 'PostToolUse', { tool_name: 'Read', tool_use_id: 'a', transcript_path: file, tool_input: {} }, 'midway');
    refresh(t.dir, db);
    assert.equal(summarize(db, findSession(db, 'midway'), later(1).getTime()).tokens?.requests, 1);
  });
  it('tolerates a transcript that has gone away', () => {
    const { t, db } = setup();
    claude(t.dir, 'SessionStart', { source: 'startup', transcript_path: join(t.dir, 'gone.jsonl') }, 'ffff');
    refresh(t.dir, db);
    assert.equal(ingestUsage(db), 0);
  });
});

describe('cost', () => {
  const usage = [{ model: 'm', input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_creation_tokens: 0 }];
  const cached = [{ model: 'm', input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_creation_tokens: 0 }];
  it('is an estimate from catalog prices, only when every token type is priced', () => {
    const r = priceUsage(usage, { m: { input: 3, output: 15 } });
    assert.equal(r.costUsd, 18);
    assert.equal(r.source, 'catalog_estimate');
    assert.equal(priceUsage(cached, { m: { input: 3, output: 15, cachedInput: 0.3 } }).costUsd, 0.3);
  });
  it('is unknown, never zero or partial, when a price is missing', () => {
    for (const r of [priceUsage(usage, undefined), priceUsage(usage, {}), priceUsage(cached, { m: { input: 3, output: 15 } }), priceUsage([...usage, { ...usage[0]!, model: null }], { m: { input: 3, output: 15 } }), priceUsage([], { m: { input: 1, output: 1 } })]) {
      assert.equal(r.costUsd, null);
      assert.equal(r.source, 'unknown');
      assert.ok(r.note);
    }
    assert.match(priceUsage(cached, { m: { input: 3, output: 15 } }).note ?? '', /cache reads/);
  });
  it('renders unknown as a word, and an estimate as an estimate', () => {
    assert.equal(formatCost({ costUsd: null, source: 'unknown' }), 'unknown');
    assert.match(formatCost({ costUsd: 0.42, source: 'catalog_estimate' }), /~\$0\.4200 estimated/);
  });
});

describe('finding and comparing', () => {
  it('finds by unique prefix, and refuses ambiguity or an unknown id', () => {
    const { t, db } = setup();
    claude(t.dir, 'SessionStart', { source: 'startup' }, 'abc111');
    claude(t.dir, 'SessionStart', { source: 'startup' }, 'abc222');
    refresh(t.dir, db);
    assert.equal(findSession(db, 'abc1').session_id, 'abc111');
    assert.throws(() => findSession(db, 'abc'), /more than one/);
    assert.throws(() => findSession(db, 'zzz'), /No session/);
    assert.throws(() => findSession(db, '%'), /No session/);
    assert.equal(listSessions(db, { agent: 'codex' }).length, 0);
    assert.equal(listSessions(db, { agent: 'claude' }).length, 2);
  });
  it('compares which files two sessions changed', () => {
    const { t, db } = setup();
    const edit = (s: string, f: string, id: string) => claude(t.dir, 'PostToolUse', { tool_name: 'Edit', tool_use_id: id, tool_input: { file_path: join(t.dir, f) } }, s);
    edit('one', 'a.ts', '1');
    edit('one', 'shared.ts', '2');
    edit('two', 'b.ts', '3');
    edit('two', 'shared.ts', '4');
    refresh(t.dir, db);
    const now = later(1).getTime();
    const cmp = compareSessions(summarize(db, findSession(db, 'one'), now), summarize(db, findSession(db, 'two'), now));
    assert.deepEqual(cmp.sharedFiles, ['shared.ts']);
    assert.deepEqual(cmp.onlyA, ['a.ts']);
    assert.deepEqual(cmp.onlyB, ['b.ts']);
  });
  it('finds sessions that touched a file, and whether they changed it', () => {
    const { t, db } = setup();
    claude(t.dir, 'PostToolUse', { tool_name: 'Read', tool_use_id: '1', tool_input: { file_path: join(t.dir, 'a.ts') } }, 'reader');
    claude(t.dir, 'PostToolUse', { tool_name: 'Edit', tool_use_id: '2', tool_input: { file_path: join(t.dir, 'a.ts') } }, 'writer');
    refresh(t.dir, db);
    const found = Object.fromEntries(sessionsForPath(db, 'a.ts').map((s) => [s.id, s.changed]));
    assert.deepEqual(found, { reader: false, writer: true });
    assert.deepEqual(sessionsForPath(db, 'other.ts'), []);
  });
});

describe('watch rendering', () => {
  const summary = (over: Record<string, unknown> = {}) => ({
    key: 'k', agent: 'claude-code', id: 'abcdefgh1234', branch: 'main', state: 'active', startedAt: 't', endedAt: null, lastEventAt: 't', durationMs: 754000, endReason: null, task: null, models: [],
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 18420, requests: 1 }, cost: { costUsd: null, source: 'unknown' },
    counts: { tasks: 1, filesRead: 0, filesCreated: 1, filesModified: 3, filesDeleted: 0, commands: 1, tools: 0, errors: 0, testsPassed: 0, testsFailed: 0, testsUnknown: 0 },
    files: { read: [], created: [], modified: [], deleted: [] }, commands: [], ...over,
  }) as never;
  const base = { project: 'demo', branch: 'main', width: 100, height: 30, agents: [{ name: 'Claude Code', status: 'active' as const }, { name: 'OpenAI Codex', status: 'not connected' as const }] };

  it('shows real numbers, and unknown where there is no data', () => {
    const f = renderFrame({ ...base, sessions: [{ summary: summary(), events: [{ type: 'FILE_MODIFIED', at: '2026-11-02T10:00:05.000Z', tool: 'Edit', path: 'src/a.ts', command: null, ok: null }] }] });
    assert.match(f, /● Claude Code\s+active/);
    assert.match(f, /○ OpenAI Codex\s+not connected/);
    assert.match(f, /12m 34s/);
    assert.match(f, /tokens 18,420/);
    assert.match(f, /cost unknown/);
    assert.match(f, /changed 4/);
    assert.match(f, /10:00:05 {2}~ src\/a\.ts/);
    assert.match(renderFrame({ ...base, sessions: [{ summary: summary({ tokens: null }), events: [] }] }), /tokens unknown/);
  });
  it('explains an empty state', () => {
    assert.match(renderFrame({ ...base, sessions: [] }), /No sessions yet/);
  });
  it('fits the terminal when it is resized small, keeping the way out visible', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ type: 'FILE_READ', at: `2026-11-02T10:00:${String(i).padStart(2, '0')}.000Z`, tool: null, path: `src/${'x'.repeat(100)}${i}.ts`, command: null, ok: null }));
    const f = renderFrame({ ...base, width: 40, height: 10, sessions: [{ summary: summary(), events }] }).split('\n');
    assert.ok(f.length <= 9, `${f.length} lines`);
    assert.ok(f.every((l) => l.length <= 40));
    assert.equal(f[f.length - 1], 'Ctrl+C to stop');
  });
  it('labels failures', () => {
    assert.match(eventLine({ type: 'TEST_EXECUTED', at: '2026-11-02T10:00:05.000Z', tool: 'Bash', path: null, command: 'npm test', ok: 0 }), /T npm test {2}failed/);
  });
  it('formats durations', () => {
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(754_000), '12m 34s');
    assert.equal(formatDuration(3_900_000), '1h 5m');
  });
});

describe('tokenistt sessions and watch (end to end)', () => {
  const repo = () => {
    const t = gitRepo({ 'a.ts': 'x' });
    cleanups.push(t.cleanup);
    runCli(t.dir, ['init']);
    return t;
  };
  it('guides you when nothing is recorded', () => {
    const t = repo();
    const r = runCli(t.dir, ['sessions']);
    assert.equal(r.code, 0);
    assert.match(r.out, /No sessions recorded yet/);
    assert.match(r.out, /agents connect/);
  });
  it('lists, inspects and compares from recorded events', () => {
    const t = repo();
    realistic(t.dir, 'aaaa1111');
    realistic(t.dir, 'bbbb2222');
    const list = JSON.parse(runCli(t.dir, ['sessions', '--json']).out);
    assert.equal(list.sessions.length, 2);
    assert.equal(JSON.parse(runCli(t.dir, ['sessions', 'history', '--agent', 'codex', '--json']).out).sessions.length, 0);
    const human = runCli(t.dir, ['sessions']);
    assert.match(human.out, /aaaa1111/);
    assert.match(human.out, /unknown/, 'no price catalog here, so cost is unknown');
    const inspected = runCli(t.dir, ['sessions', 'inspect', 'aaaa']);
    assert.equal(inspected.code, 0, inspected.err);
    assert.match(inspected.out, /385 over 2 requests/);
    assert.match(inspected.out, /no price table/);
    assert.match(inspected.out, /\+ new\.ts/);
    assert.match(inspected.out, /1 passed, 1 failed/);
    const compared = runCli(t.dir, ['sessions', 'compare', 'aaaa', 'bbbb']);
    assert.equal(compared.code, 0, compared.err);
    assert.match(compared.out, /Changed by both: a\.ts, new\.ts/);
    assert.equal(runCli(t.dir, ['sessions', 'inspect', 'nope']).code, 2);
    assert.equal(runCli(t.dir, ['sessions', '--limit', 'x']).code, 2);
  });
  it('prints no secret in any output', () => {
    const t = repo();
    claude(t.dir, 'UserPromptSubmit', { prompt: 'PROMPT_SECRET', prompt_id: 'p' });
    claude(t.dir, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'curl -H "Authorization: Bearer ABC" https://x' } });
    const out = runCli(t.dir, ['sessions', 'inspect', 'aaaa', '--json']).out;
    assert.doesNotMatch(out, /PROMPT_SECRET|ABC/);
  });

  it('watch streams new events as NDJSON when piped, without control codes, and stops cleanly', async (ctx) => {
    if (process.platform === 'win32') return ctx.skip('signals cannot be sent to a child process portably on Windows');
    const t = repo();
    claude(t.dir, 'SessionStart', { source: 'startup' }, 'live1', new Date());
    const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const child = spawn(process.execPath, ['--import', tsx, main, 'watch', '--json', '--interval', '200'], { cwd: t.dir, env: { PATH: process.env.PATH, NO_COLOR: '1', TOKENISTT_CONFIG_DIR: join(t.dir, '.test-config') } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const until = async (cond: () => boolean) => { const end = Date.now() + 20000; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); assert.ok(cond(), `timed out; got: ${out}`); };
    await until(() => out.includes('SESSION_STARTED'));
    claude(t.dir, 'PostToolUse', { tool_name: 'Edit', tool_use_id: 'z', tool_input: { file_path: join(t.dir, 'a.ts') } }, 'live1', new Date());
    await until(() => out.includes('FILE_MODIFIED'));
    const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    child.kill('SIGINT');
    assert.equal(await exited, 0);
    assert.doesNotMatch(out, /\x1b/);
    assert.equal(out.match(/FILE_MODIFIED/g)?.length, 1, 'each event once');
    for (const line of out.trim().split('\n')) JSON.parse(line);
  });
});
