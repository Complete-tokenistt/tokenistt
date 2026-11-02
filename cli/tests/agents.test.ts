import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { claudeCode, parseClaudeTranscript } from '../src/agents/adapters/claude-code.js';
import { applyPlan, hookCommand, isConnected, planConnect, planDisconnect, previewDiff } from '../src/agents/connect.js';
import { currentBranch, findProjectRoot, handleHook } from '../src/agents/hook-main.js';
import { commandName, deletedPaths, isTestCommand, redactCommand, repoPath, shapeCommand } from '../src/agents/normalize.js';
import { ingestEvents } from '../src/agents/session-manager.js';
import type { HookTarget } from '../src/agents/adapter.js';
import type { NormalizeContext } from '../src/agents/schemas.js';
import { repoInfo } from '../src/project/git.js';
import { openDatabase } from '../src/store/db.js';
import { initProject } from '../src/store/project.js';
import { gitRepo, runCli, tempDir } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const ROOT = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const inRepo = (p: string): string => (process.platform === 'win32' ? `C:\\repo\\${p.replaceAll('/', '\\')}` : `/repo/${p}`);
const ctx = (over: Partial<NormalizeContext> = {}): NormalizeContext => ({ root: ROOT, branch: 'main', now: new Date('2026-11-02T10:00:00.000Z'), privacy: { commands: 'name', capturePrompts: false }, ...over });
const hook = (name: string, extra: Record<string, unknown> = {}) => ({ session_id: 'abc-123', hook_event_name: name, cwd: ROOT, transcript_path: '/home/me/.claude/x.jsonl', ...extra });

describe('command privacy', () => {
  it('keeps only program and subcommand by default', () => {
    assert.equal(commandName('npm test --watch'), 'npm test');
    assert.equal(commandName('git commit -m "secret plan"'), 'git commit');
    assert.equal(commandName('API_KEY=abc123 node server.js --port 80'), 'node');
    assert.equal(commandName('/usr/local/bin/python3 script.py'), 'python3');
    assert.equal(commandName('sudo docker ps'), 'docker ps');
    assert.equal(commandName('curl https://x.dev/?token=abc'), 'curl');
  });
  it('scrubs secrets when full commands are opted into', () => {
    const r = redactCommand('API_TOKEN=abc123 curl -H "Authorization: Bearer abcdefghijkl" --password hunter2 https://u:pw123@host/x --api-key=k9');
    for (const leak of ['abc123', 'abcdefghijkl', 'hunter2', 'pw123', 'k9']) assert.doesNotMatch(r, new RegExp(leak), leak);
    assert.match(r, /curl/);
  });
  it('shapes by setting', () => {
    assert.equal(shapeCommand('npm test -- --x', 'none'), undefined);
    assert.equal(shapeCommand('npm test -- --x', 'name'), 'npm test');
    assert.equal(shapeCommand('npm test -- --x', 'redacted'), 'npm test -- --x');
    assert.equal(shapeCommand(42, 'name'), undefined);
  });
  it('recognises test commands', () => {
    for (const c of ['npm test', 'npm run test', 'pnpm test:unit', 'go test ./...', 'cargo test', 'pytest -q', 'python -m pytest', 'npx vitest run', 'dotnet test', 'mvn clean test', 'node --test x.js']) assert.ok(isTestCommand(c), c);
    for (const c of ['npm run build', 'git commit -m test', 'cat test.txt', 'ls tests', 'echo testing']) assert.equal(isTestCommand(c), false, c);
  });
  it('reads deletions only from plain commands', () => {
    assert.deepEqual(deletedPaths('rm -f a.txt b.txt'), ['a.txt', 'b.txt']);
    assert.deepEqual(deletedPaths('git rm old.ts'), ['old.ts']);
    assert.deepEqual(deletedPaths('rm *.log'), []);
    assert.deepEqual(deletedPaths('rm a; echo b'), []);
    assert.deepEqual(deletedPaths('git status'), []);
  });
});

describe('repoPath', () => {
  it('makes paths relative and drops anything outside the repository', () => {
    assert.equal(repoPath(ROOT, ROOT, inRepo('src/a.ts')), 'src/a.ts');
    assert.equal(repoPath(ROOT, inRepo('src'), 'a.ts'), 'src/a.ts');
    assert.equal(repoPath(ROOT, ROOT, process.platform === 'win32' ? 'C:\\Users\\me\\.ssh\\id_rsa' : '/home/me/.ssh/id_rsa'), undefined);
    assert.equal(repoPath(ROOT, ROOT, '../outside.txt'), undefined);
    assert.equal(repoPath(ROOT, ROOT, inRepo('.tokenistt/config.json')), undefined);
    assert.equal(repoPath(ROOT, ROOT, undefined), undefined);
  });
});

describe('Claude Code normalization', () => {
  const n = (input: Record<string, unknown>, c = ctx()) => claudeCode.normalizeEvent(input, c);

  it('maps session lifecycle', () => {
    const start = n(hook('SessionStart', { source: 'startup', model: 'claude-opus-5-5' }))[0];
    assert.equal(start?.type, 'SESSION_STARTED');
    assert.equal(start?.model, 'claude-opus-5-5');
    assert.equal(start?.branch, 'main');
    assert.equal(start?.transcript, '/home/me/.claude/x.jsonl');
    assert.equal(n(hook('SessionStart', { source: 'resume' }))[0]?.type, 'SESSION_RESUMED');
    assert.deepEqual(n(hook('SessionStart', { source: 'compact' })), []);
    assert.deepEqual(n(hook('SessionStart', { source: 'clear' })), []);
    assert.equal(n(hook('Stop'))[0]?.type, 'TASK_COMPLETED');
    const end = n(hook('SessionEnd', { reason: 'prompt_input_exit' }))[0];
    assert.equal(end?.type, 'SESSION_ENDED');
    assert.equal(end?.reason, 'prompt_input_exit');
  });

  it('never keeps the prompt unless asked', () => {
    const input = hook('UserPromptSubmit', { prompt: 'fix the auth bug using key sk-secret' });
    const e = n(input)[0];
    assert.equal(e?.type, 'TASK_STARTED');
    assert.doesNotMatch(JSON.stringify(e), /auth bug|sk-secret/);
    const opted = n(input, ctx({ privacy: { commands: 'name', capturePrompts: true } }))[0];
    assert.match(opted?.task ?? '', /auth bug/);
  });

  it('maps file tools to repo-relative paths with no content', () => {
    const read = n(hook('PostToolUse', { tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: inRepo('src/a.ts') }, tool_response: { file: { content: 'SECRET_CONTENT' } } }))[0];
    assert.equal(read?.type, 'FILE_READ');
    assert.equal(read?.path, 'src/a.ts');
    assert.doesNotMatch(JSON.stringify(read), /SECRET_CONTENT/);
    const created = n(hook('PostToolUse', { tool_name: 'Write', tool_use_id: 't2', tool_input: { file_path: inRepo('b.ts'), content: 'WRITTEN_CONTENT' }, tool_response: { type: 'create' } }))[0];
    assert.equal(created?.type, 'FILE_CREATED');
    assert.doesNotMatch(JSON.stringify(created), /WRITTEN_CONTENT/);
    assert.equal(n(hook('PostToolUse', { tool_name: 'Edit', tool_use_id: 't3', tool_input: { file_path: inRepo('b.ts'), old_string: 'x', new_string: 'y' }, tool_response: {} }))[0]?.type, 'FILE_MODIFIED');
    const outside = n(hook('PostToolUse', { tool_name: 'Read', tool_use_id: 't4', tool_input: { file_path: process.platform === 'win32' ? 'C:\\Users\\me\\secret' : '/home/me/secret' } }))[0];
    assert.equal(outside?.type, 'FILE_READ');
    assert.equal(outside?.path, undefined);
  });

  it('maps commands, tests, deletions and other tools', () => {
    const cmd = n(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'git push --token abc' }, tool_response: { stdout: 'OUTPUT_TEXT' } }))[0];
    assert.equal(cmd?.type, 'COMMAND_EXECUTED');
    assert.equal(cmd?.command, 'git push');
    assert.doesNotMatch(JSON.stringify(cmd), /OUTPUT_TEXT|--token/);
    const test = n(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'npm test' }, tool_response: {} }))[0];
    assert.equal(test?.type, 'TEST_EXECUTED');
    assert.equal(test?.ok, true);
    const types = n(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 't3', tool_input: { command: 'rm a.ts' }, tool_response: {} })).map((e) => `${e.type}:${e.path ?? ''}`);
    assert.deepEqual(types, ['COMMAND_EXECUTED:', 'FILE_DELETED:a.ts']);
    assert.equal(n(hook('PostToolUse', { tool_name: 'mcp__x__y', tool_use_id: 't4', tool_input: { q: 'PRIVATE' } }))[0]?.type, 'TOOL_INVOKED');
  });

  it('records failures without error text', () => {
    const fail = n(hook('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' }, error: 'ERROR_TEXT' }))[0];
    assert.equal(fail?.type, 'TEST_EXECUTED');
    assert.equal(fail?.ok, false);
    assert.doesNotMatch(JSON.stringify(fail), /ERROR_TEXT/);
    const other = n(hook('PostToolUseFailure', { tool_name: 'Edit', tool_use_id: 't2', error: 'ERROR_TEXT' }))[0];
    assert.equal(other?.type, 'ERROR_OCCURRED');
    assert.equal(n(hook('StopFailure', { error: 'rate_limit' }))[0]?.ok, false);
  });

  it('ignores unknown events and malformed input', () => {
    assert.deepEqual(n(hook('SomethingNew')), []);
    assert.deepEqual(n({ hook_event_name: 'Stop' }), []);
    assert.deepEqual(n({ session_id: 'x' }), []);
    assert.deepEqual(n(hook('PostToolUse', { tool_name: 42 })), []);
  });

  it('gives a redelivered event the same id, and repeats different ones', () => {
    const a = n(hook('PostToolUse', { tool_name: 'Read', tool_use_id: 't1', tool_input: {} }))[0];
    const again = n(hook('PostToolUse', { tool_name: 'Read', tool_use_id: 't1', tool_input: {} }), ctx({ now: new Date('2026-11-02T10:05:00.000Z') }))[0];
    assert.equal(a?.id, again?.id);
    const other = n(hook('PostToolUse', { tool_name: 'Read', tool_use_id: 't2', tool_input: {} }))[0];
    assert.notEqual(a?.id, other?.id);
    const stopLater = n(hook('Stop'), ctx({ now: new Date('2026-11-02T10:05:00.000Z') }))[0];
    assert.notEqual(n(hook('Stop'))[0]?.id, stopLater?.id);
  });
});

describe('Claude transcript usage', () => {
  const line = (requestId: string, usage: unknown, model = 'claude-opus-5-5') => JSON.stringify({ type: 'assistant', requestId, timestamp: 't', message: { model, usage, content: 'hi' } });
  it('takes the last line for each request, so streaming is not double counted', () => {
    const out = parseClaudeTranscript([
      line('r1', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }),
      line('r1', { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 }),
      line('r2', { input_tokens: 3, output_tokens: 4 }),
    ].join('\n'));
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { requestId: 'r1', model: 'claude-opus-5-5', at: 't', inputTokens: 10, outputTokens: 40, cacheReadTokens: 5, cacheCreationTokens: 2 });
    assert.equal(out[1]?.cacheReadTokens, 0);
  });
  it('skips anything it does not recognise, rather than producing wrong numbers', () => {
    const out = parseClaudeTranscript(['not json with "usage"', JSON.stringify({ type: 'user', usage: {} }), JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1 } } }), line('r', { input_tokens: 'many', output_tokens: -5 }), line('s', { input_tokens: 1 }, '<synthetic>')].join('\n'));
    assert.equal(out[0]?.inputTokens, 0);
    assert.equal(out[0]?.outputTokens, 0);
    assert.equal(out[1]?.model, undefined);
    assert.equal(out.length, 2);
  });
});

describe('connecting hooks', () => {
  const setup = (content?: string): HookTarget => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, '.claude', 'settings.local.json');
    if (content !== undefined) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return { scope: 'project', file, format: 'claude-json' };
  };
  const CMD = hookCommand('claude-code', '/usr/bin/node', '/opt/tokenistt/bin/tokenistt.js');

  it('quotes paths so spaces survive', () => {
    assert.equal(CMD, '"/usr/bin/node" "/opt/tokenistt/bin/tokenistt.js" hook claude-code');
  });
  it('creates the file when there is none', () => {
    const target = setup();
    const plan = planConnect(claudeCode, target, CMD);
    assert.equal(plan.changed, true);
    assert.equal(applyPlan(target, plan.after), undefined);
    const s = JSON.parse(readFileSync(target.file, 'utf8'));
    for (const e of claudeCode.hookEvents) assert.equal(s.hooks[e][0].hooks[0].command, CMD);
    assert.equal(isConnected(claudeCode, target), true);
  });
  it('keeps every other setting and hook, and writes a backup', () => {
    const original = JSON.stringify({ model: 'x', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-own-hook' }] }], Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }] } });
    const target = setup(original);
    const backup = applyPlan(target, planConnect(claudeCode, target, CMD).after);
    assert.equal(readFileSync(backup as string, 'utf8'), original);
    const s = JSON.parse(readFileSync(target.file, 'utf8'));
    assert.equal(s.model, 'x');
    assert.deepEqual(s.permissions.allow, ['Bash(ls)']);
    assert.equal(s.hooks.Notification[0].hooks[0].command, 'notify');
    assert.equal(s.hooks.Stop.length, 2);
    assert.equal(s.hooks.Stop[0].hooks[0].command, 'my-own-hook');
  });
  it('is idempotent, and updates a stale path rather than adding a second entry', () => {
    const target = setup();
    applyPlan(target, planConnect(claudeCode, target, CMD).after);
    assert.equal(planConnect(claudeCode, target, CMD).changed, false);
    const moved = hookCommand('claude-code', '/new/node', '/new/tokenistt/bin/tokenistt.js');
    const plan = planConnect(claudeCode, target, moved);
    assert.equal(plan.changed, true);
    applyPlan(target, plan.after);
    const s = JSON.parse(readFileSync(target.file, 'utf8'));
    assert.equal(s.hooks.Stop.length, 1);
    assert.equal(s.hooks.Stop[0].hooks[0].command, moved);
  });
  it('disconnect removes only our entries, restoring the original settings', () => {
    const original = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] } };
    const target = setup(JSON.stringify(original));
    applyPlan(target, planConnect(claudeCode, target, CMD).after);
    assert.equal(isConnected(claudeCode, target), true);
    const plan = planDisconnect(claudeCode, target);
    assert.equal(plan.changed, true);
    applyPlan(target, plan.after);
    assert.deepEqual(JSON.parse(readFileSync(target.file, 'utf8')), original);
    assert.equal(isConnected(claudeCode, target), false);
    assert.equal(planDisconnect(claudeCode, target).changed, false);
  });
  it('does not touch a hook that merely mentions a similar name', () => {
    const target = setup(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-script hook claude-code' }] }] } }));
    assert.equal(planDisconnect(claudeCode, target).changed, false);
  });
  it('refuses a file it cannot parse, leaving it alone', () => {
    const target = setup('{ "model": "x", // a comment\n }');
    assert.throws(() => planConnect(claudeCode, target, CMD), /not valid JSON/);
    assert.throws(() => planConnect(claudeCode, setup('[1,2]'), CMD), /not valid JSON/);
    assert.match(readFileSync(target.file, 'utf8'), /a comment/);
  });
  it('previews just what changes', () => {
    assert.equal(previewDiff('a\nb\nc\n', 'a\nx\nc\n'), '- b\n+ x');
  });
});

describe('hook fast path', () => {
  function project(files: Record<string, string> = { 'a.ts': 'x' }) {
    const t = gitRepo(files);
    cleanups.push(t.cleanup);
    initProject(repoInfo(t.dir)!);
    return t;
  }
  const payload = (dir: string, extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: 's1', hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Read', tool_use_id: 'x', tool_input: { file_path: join(dir, 'a.ts') }, tool_response: { file: { content: 'FILE_CONTENT' } }, ...extra });

  it('finds the project from a subdirectory and reads the branch without git', () => {
    const t = project({ 'src/a.ts': 'x' });
    assert.equal(findProjectRoot(join(t.dir, 'src')), t.dir);
    assert.equal(currentBranch(t.dir), 'main');
    const outside = tempDir();
    cleanups.push(outside.cleanup);
    assert.equal(findProjectRoot(outside.dir), undefined);
  });
  it('appends one line per event, with no content', () => {
    const t = project();
    assert.equal(handleHook('claude-code', payload(t.dir)), 1);
    const file = join(t.dir, '.tokenistt', 'sessions', 'claude-code.s1.jsonl');
    const line = JSON.parse(readFileSync(file, 'utf8').trim());
    assert.equal(line.path, 'a.ts');
    assert.equal(line.branch, 'main');
    assert.doesNotMatch(readFileSync(file, 'utf8'), /FILE_CONTENT/);
  });
  it('does nothing outside a set-up repository', () => {
    const t = gitRepo({ 'a.ts': 'x' });
    cleanups.push(t.cleanup);
    assert.equal(handleHook('claude-code', payload(t.dir)), 0);
    assert.equal(existsSync(join(t.dir, '.tokenistt')), false);
  });
  it('refuses a session id that could escape the sessions folder', () => {
    const t = project();
    assert.equal(handleHook('claude-code', payload(t.dir, { session_id: '../../evil' })), 0);
    assert.deepEqual(readdirSync(join(t.dir, '.tokenistt', 'sessions')), []);
  });
  it('honours the privacy setting, and falls back to private on a bad value', () => {
    const t = project();
    const cfgFile = join(t.dir, '.tokenistt', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    const bash = (id: string) => payload(t.dir, { tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'deploy --prod now' }, tool_response: {} });
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, privacy: { commands: 'none' } }));
    handleHook('claude-code', bash('a'));
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, privacy: { commands: 'everything' } }));
    handleHook('claude-code', bash('b'));
    const lines = readFileSync(join(t.dir, '.tokenistt', 'sessions', 'claude-code.s1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].command, undefined);
    assert.equal(lines[1].command, 'deploy');
  });

  const runBin = (stdin: string, cwd: string) => {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const entry = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agents', 'hook-main.ts')).href;
    const code = `import(${JSON.stringify(entry)}).then((m) => m.runHook(['node', 'tokenistt', 'hook', 'claude-code']));`;
    return spawnSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', code], { cwd, input: stdin, encoding: 'utf8' });
  };
  it('always exits 0 with empty stdout, whatever it is given', () => {
    const t = project();
    for (const input of ['', 'not json', '[]', '{}', payload(t.dir), payload('/definitely/not/here')]) {
      const r = runBin(input, t.dir);
      assert.equal(r.status, 0, input);
      assert.equal(r.stdout, '', input);
    }
  });
});

describe('ingesting events', () => {
  function setup() {
    const t = gitRepo({ 'a.ts': 'x' });
    cleanups.push(t.cleanup);
    initProject(repoInfo(t.dir)!);
    const db = openDatabase(t.dir);
    cleanups.push(() => db.close());
    return { t, db };
  }
  const send = (dir: string, name: string, extra: Record<string, unknown> = {}, session = 's1', now = new Date('2026-11-02T10:00:00Z')) =>
    handleHook('claude-code', JSON.stringify({ session_id: session, hook_event_name: name, cwd: dir, ...extra }), now);
  const session = (db: ReturnType<typeof openDatabase>, id = 's1') => db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(id) as Record<string, unknown>;

  it('builds session state from events, and only reads new bytes', () => {
    const { t, db } = setup();
    send(t.dir, 'SessionStart', { source: 'startup', model: 'm1', transcript_path: '/x/t.jsonl' });
    send(t.dir, 'PostToolUse', { tool_name: 'Edit', tool_use_id: 'a', tool_input: { file_path: join(t.dir, 'a.ts') }, tool_response: {} });
    assert.deepEqual(ingestEvents(t.dir, db), { files: 1, events: 2 });
    assert.equal(session(db).status, 'active');
    assert.equal(session(db).model, 'm1');
    assert.equal(session(db).branch, 'main');
    assert.equal(ingestEvents(t.dir, db).events, 0);
    send(t.dir, 'SessionEnd', { reason: 'clear' }, 's1', new Date('2026-11-02T10:30:00Z'));
    assert.equal(ingestEvents(t.dir, db).events, 1);
    assert.equal(session(db).status, 'ended');
    assert.equal(session(db).ended_at, '2026-11-02T10:30:00.000Z');
    assert.equal((db.prepare('SELECT count(*) AS c FROM agent_events').get() as { c: number }).c, 3);
  });
  it('stores a duplicate delivery once', () => {
    const { t, db } = setup();
    const e = { tool_name: 'Read', tool_use_id: 'same', tool_input: {}, tool_response: {} };
    send(t.dir, 'PostToolUse', e);
    send(t.dir, 'PostToolUse', e);
    assert.equal(ingestEvents(t.dir, db).events, 1);
  });
  it('keeps concurrent sessions apart', () => {
    const { t, db } = setup();
    send(t.dir, 'SessionStart', { source: 'startup' }, 'one');
    send(t.dir, 'SessionStart', { source: 'startup' }, 'two');
    ingestEvents(t.dir, db);
    assert.equal((db.prepare('SELECT count(*) AS c FROM agent_sessions').get() as { c: number }).c, 2);
  });
  it('resuming reopens an ended session', () => {
    const { t, db } = setup();
    send(t.dir, 'SessionStart', { source: 'startup' });
    send(t.dir, 'SessionEnd', { reason: 'other' }, 's1', new Date('2026-11-02T10:10:00Z'));
    ingestEvents(t.dir, db);
    send(t.dir, 'SessionStart', { source: 'resume' }, 's1', new Date('2026-11-02T11:00:00Z'));
    ingestEvents(t.dir, db);
    assert.equal(session(db).status, 'active');
    assert.equal(session(db).ended_at, null);
  });
  it('leaves a half-written line for later, and survives a corrupt one', () => {
    const { t, db } = setup();
    send(t.dir, 'SessionStart', { source: 'startup' });
    const file = join(t.dir, '.tokenistt', 'sessions', 'claude-code.s1.jsonl');
    appendFileSync(file, 'garbage line\n{"partial":');
    assert.equal(ingestEvents(t.dir, db).events, 1);
    appendFileSync(file, '1}\n');
    send(t.dir, 'Stop');
    const again = ingestEvents(t.dir, db);
    assert.ok(again.events >= 1);
    assert.equal(session(db).status, 'active');
  });
  it('tolerates having no sessions folder', () => {
    const { t, db } = setup();
    assert.deepEqual(ingestEvents(join(t.dir, 'missing'), db), { files: 0, events: 0 });
  });
});

describe('tokenistt agents (end to end)', () => {
  const setup = () => {
    const t = gitRepo({ 'a.ts': 'x', '.gitignore': '.test-config\n' });
    const home = tempDir();
    cleanups.push(t.cleanup, home.cleanup);
    runCli(t.dir, ['init']);
    return { t, env: { TOKENISTT_HOME: home.dir }, home };
  };
  it('lists agents, without touching real settings', () => {
    const { t, env } = setup();
    const body = JSON.parse(runCli(t.dir, ['agents', '--json'], { env }).out);
    const claude = body.agents.find((a: { agent: string }) => a.agent === 'claude-code');
    assert.equal(claude.connected, null);
    assert.equal(claude.verification, 'live');
  });
  it('dry-run changes nothing; non-interactive without --yes refuses', () => {
    const { t, env } = setup();
    const settings = join(t.dir, '.claude', 'settings.local.json');
    const dry = runCli(t.dir, ['agents', 'connect', 'claude-code', '--dry-run'], { env });
    assert.equal(dry.code, 0);
    assert.match(dry.out, /SessionStart/);
    assert.equal(existsSync(settings), false);
    const refused = runCli(t.dir, ['agents', 'connect', 'claude-code'], { env });
    assert.equal(refused.code, 2);
    assert.match(refused.err, /--yes/);
    assert.equal(existsSync(settings), false);
  });
  it('connects and disconnects, and accepts the short name', () => {
    const { t, env } = setup();
    assert.equal(runCli(t.dir, ['agents', 'connect', 'claude', '--yes'], { env }).code, 0);
    assert.equal(JSON.parse(runCli(t.dir, ['agents', '--json'], { env }).out).agents[0].connected, 'project');
    assert.match(readFileSync(join(t.dir, '.claude', 'settings.local.json'), 'utf8'), /hook claude-code/);
    assert.match(runCli(t.dir, ['agents', 'connect', 'claude', '--yes'], { env }).out, /already connected/);
    assert.equal(runCli(t.dir, ['agents', 'disconnect', 'claude', '--yes'], { env }).code, 0);
    assert.doesNotMatch(readFileSync(join(t.dir, '.claude', 'settings.local.json'), 'utf8'), /tokenistt/);
  });
  it('--user writes to the home settings', () => {
    const { t, env, home } = setup();
    assert.equal(runCli(t.dir, ['agents', 'connect', 'claude', '--user', '--yes'], { env }).code, 0);
    assert.ok(existsSync(join(home.dir, '.claude', 'settings.json')));
    assert.equal(existsSync(join(t.dir, '.claude')), false);
  });
  it('shows the capability table and rejects unknown agents', () => {
    const { t, env } = setup();
    const r = runCli(t.dir, ['agents', 'capabilities'], { env });
    assert.match(r.out, /tokens/);
    assert.match(r.out, /best-effort/);
    assert.match(r.out, /checked against the real agent/);
    assert.equal(runCli(t.dir, ['agents', 'connect', 'cursor', '--yes'], { env }).code, 2);
  });
});
