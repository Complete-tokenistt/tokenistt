/** Inputs here are copied from the agents' published documentation, not from running them. */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { antigravity } from '../src/agents/adapters/antigravity.js';
import { codex, patchTargets } from '../src/agents/adapters/codex.js';
import { applyPlan, isConnected, planConnect, planDisconnect } from '../src/agents/connect.js';
import { handleHook } from '../src/agents/hook-main.js';
import { ADAPTERS, adapterFor } from '../src/agents/registry.js';
import { CAPABILITY_KEYS, type NormalizeContext } from '../src/agents/schemas.js';
import type { HookTarget } from '../src/agents/adapter.js';
import { repoInfo } from '../src/project/git.js';
import { initProject } from '../src/store/project.js';
import { gitRepo, runCli, tempDir } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const ROOT = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const inRepo = (p: string): string => (process.platform === 'win32' ? `C:\\repo\\${p.replaceAll('/', '\\')}` : `/repo/${p}`);
const ctx = (over: Partial<NormalizeContext> = {}): NormalizeContext => ({ root: ROOT, branch: 'main', now: new Date('2026-11-02T10:00:00.000Z'), privacy: { commands: 'name', capturePrompts: false }, ...over });

describe('Codex normalization', () => {
  const hook = (name: string, extra: Record<string, unknown> = {}) => ({ session_id: 's1', transcript_path: null, cwd: ROOT, hook_event_name: name, model: 'gpt-5', ...extra });
  const n = (input: Record<string, unknown>, c = ctx()) => codex.normalizeEvent(input, c);

  it('maps the session lifecycle and carries the model on every event', () => {
    const start = n(hook('SessionStart', { source: 'startup' }))[0];
    assert.equal(start?.type, 'SESSION_STARTED');
    assert.equal(start?.model, 'gpt-5');
    assert.equal(n(hook('SessionStart', { source: 'resume' }))[0]?.type, 'SESSION_RESUMED');
    assert.deepEqual(n(hook('SessionStart', { source: 'compact' })), []);
    assert.equal(n(hook('Stop', { turn_id: 't1', last_assistant_message: 'ANSWER_TEXT' }))[0]?.type, 'TASK_COMPLETED');
    assert.doesNotMatch(JSON.stringify(n(hook('Stop', { turn_id: 't1', last_assistant_message: 'ANSWER_TEXT' }))), /ANSWER_TEXT/);
    assert.equal(n(hook('SessionEnd', { reason: 'other' }))[0]?.type, 'SESSION_ENDED');
  });
  it('does not keep the prompt unless asked', () => {
    const input = hook('UserPromptSubmit', { turn_id: 't', prompt: 'PROMPT_TEXT' });
    assert.doesNotMatch(JSON.stringify(n(input)), /PROMPT_TEXT/);
    assert.equal(n(input, ctx({ privacy: { commands: 'name', capturePrompts: true } }))[0]?.task, 'PROMPT_TEXT');
  });
  it('reads file names from patch headers and never keeps the patch', () => {
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+const secret = "PATCH_BODY";
*** Update File: src/old.ts
@@
-a
+b
*** Delete File: src/gone.ts
*** End Patch`;
    assert.deepEqual(patchTargets(patch), [{ path: 'src/new.ts', action: 'add' }, { path: 'src/old.ts', action: 'update' }, { path: 'src/gone.ts', action: 'delete' }]);
    const events = n(hook('PostToolUse', { tool_name: 'apply_patch', tool_use_id: 'u1', turn_id: 't', tool_input: { command: patch }, tool_response: 'OUTPUT' }));
    assert.deepEqual(events.map((e) => `${e.type}:${e.path}`), ['FILE_CREATED:src/new.ts', 'FILE_MODIFIED:src/old.ts', 'FILE_DELETED:src/gone.ts']);
    assert.doesNotMatch(JSON.stringify(events), /PATCH_BODY|OUTPUT/);
    assert.equal(new Set(events.map((e) => e.id)).size, 3);
  });
  it('drops patch paths outside the repository', () => {
    const e = n(hook('PostToolUse', { tool_name: 'apply_patch', tool_use_id: 'u', tool_input: { command: '*** Update File: ../../etc/passwd\n' } }))[0];
    assert.equal(e?.type, 'FILE_MODIFIED');
    assert.equal(e?.path, undefined);
  });
  it('records commands and leaves pass or fail unknown, because the hook also fires on failure', () => {
    const cmd = n(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'u', tool_input: { command: 'git push --force origin' }, tool_response: 'x' }))[0];
    assert.equal(cmd?.type, 'COMMAND_EXECUTED');
    assert.equal(cmd?.command, 'git push');
    assert.equal(cmd?.ok, undefined);
    const test = n(hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'v', tool_input: { command: 'cargo test' } }))[0];
    assert.equal(test?.type, 'TEST_EXECUTED');
    assert.equal(test?.ok, undefined);
  });
  it('records other tools by name only', () => {
    const e = n(hook('PostToolUse', { tool_name: 'mcp__fs__read', tool_use_id: 'u', tool_input: { path: 'PRIVATE' } }))[0];
    assert.equal(e?.type, 'TOOL_INVOKED');
    assert.equal(e?.tool, 'mcp__fs__read');
    assert.doesNotMatch(JSON.stringify(e), /PRIVATE/);
  });
  it('ignores malformed input and has no usage parser', () => {
    assert.deepEqual(n({ hook_event_name: 'Stop' }), []);
    assert.deepEqual(n(hook('Unknown')), []);
    assert.equal(codex.collectUsage, undefined);
  });
});

describe('Antigravity normalization', () => {
  const common = { conversationId: 'conv-1', workspacePaths: [ROOT], transcriptPath: '/x/t.jsonl', artifactDirectoryPath: '/x/a', modelName: 'gemini-3' };
  const n = (input: Record<string, unknown>, c = ctx()) => antigravity.normalizeEvent({ ...common, ...input }, c);

  it('works out the event from its documented fields', () => {
    assert.equal(n({})[0]?.type, 'SESSION_STARTED');
    assert.equal(n({})[0]?.model, 'gemini-3');
    assert.equal(n({ invocationNum: 1, initialNumSteps: 0 })[0]?.type, 'TASK_STARTED');
    const stop = n({ executionNum: 1, terminationReason: 'model_stop', fullyIdle: true })[0];
    assert.equal(stop?.type, 'TASK_COMPLETED');
    assert.equal(stop?.reason, 'model_stop');
    const failed = n({ executionNum: 2, terminationReason: 'error', error: 'ERROR_TEXT' })[0];
    assert.equal(failed?.type, 'ERROR_OCCURRED');
    assert.doesNotMatch(JSON.stringify(failed), /ERROR_TEXT/);
  });
  it('does not keep the prompt unless asked', () => {
    assert.doesNotMatch(JSON.stringify(n({ invocationNum: 1, lastUserInput: 'PROMPT_TEXT' })), /PROMPT_TEXT/);
    assert.equal(n({ invocationNum: 1, lastUserInput: 'PROMPT_TEXT' }, ctx({ privacy: { commands: 'name', capturePrompts: true } }))[0]?.task, 'PROMPT_TEXT');
  });
  it('maps file tools with documented argument names, and no content', () => {
    const read = n({ stepIdx: 1, toolCall: { name: 'view_file', args: { AbsolutePath: inRepo('src/a.ts'), StartLine: 1 } } })[0];
    assert.equal(read?.type, 'FILE_READ');
    assert.equal(read?.path, 'src/a.ts');
    const edit = n({ stepIdx: 2, toolCall: { name: 'replace_file_content', args: { TargetFile: inRepo('src/a.ts'), TargetContent: 'OLD_TEXT', ReplacementContent: 'NEW_TEXT' } } })[0];
    assert.equal(edit?.type, 'FILE_MODIFIED');
    assert.doesNotMatch(JSON.stringify(edit), /OLD_TEXT|NEW_TEXT/);
    assert.equal(n({ stepIdx: 3, toolCall: { name: 'write_to_file', args: { TargetFile: inRepo('b.ts'), CodeContent: 'x' } } })[0]?.type, 'FILE_CREATED');
    assert.equal(n({ stepIdx: 4, toolCall: { name: 'write_to_file', args: { TargetFile: inRepo('b.ts'), Overwrite: true } } })[0]?.type, 'FILE_MODIFIED');
  });
  it('maps commands, including from the tool call working directory', () => {
    const cmd = n({ stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: inRepo('app') } } })[0];
    assert.equal(cmd?.type, 'TEST_EXECUTED');
    assert.equal(cmd?.ok, true);
    assert.equal(cmd?.command, 'npm test');
    const del = n({ stepIdx: 2, toolCall: { name: 'run_command', args: { CommandLine: 'rm x.ts', Cwd: inRepo('app') } } });
    assert.equal(del[1]?.path, 'app/x.ts');
    const failed = n({ stepIdx: 3, error: 'boom', toolCall: { name: 'run_command', args: { CommandLine: 'make deploy' } } })[0];
    assert.equal(failed?.type, 'ERROR_OCCURRED');
    assert.equal(failed?.ok, false);
    const failedTest = n({ stepIdx: 4, error: 'boom', toolCall: { name: 'run_command', args: { CommandLine: 'pytest' } } })[0];
    assert.equal(failedTest?.type, 'TEST_EXECUTED');
    assert.equal(failedTest?.ok, false);
  });
  it('a failed file edit is an error, not a change', () => {
    const e = n({ stepIdx: 1, error: 'denied', toolCall: { name: 'replace_file_content', args: { TargetFile: inRepo('a.ts') } } })[0];
    assert.equal(e?.type, 'ERROR_OCCURRED');
    assert.equal(e?.path, undefined);
  });
  it('gives repeats of the same step the same id, and ignores malformed input', () => {
    const a = n({ stepIdx: 5, toolCall: { name: 'grep_search', args: {} } })[0];
    assert.equal(a?.id, n({ stepIdx: 5, toolCall: { name: 'grep_search', args: {} } }, ctx({ now: new Date('2026-11-02T11:00:00Z') }))[0]?.id);
    assert.notEqual(a?.id, n({ stepIdx: 6, toolCall: { name: 'grep_search', args: {} } })[0]?.id);
    assert.deepEqual(antigravity.normalizeEvent({ workspacePaths: [ROOT] }, ctx()), []);
    assert.deepEqual(n({ toolCall: { args: {} } }), []);
  });
  it('finds the project from workspacePaths through the hook path', () => {
    const t = gitRepo({ 'a.ts': 'x' });
    cleanups.push(t.cleanup);
    initProject(repoInfo(t.dir)!);
    const wrote = handleHook('antigravity', JSON.stringify({ conversationId: 'c1', workspacePaths: [t.dir], stepIdx: 1, toolCall: { name: 'view_file', args: { AbsolutePath: join(t.dir, 'a.ts') } } }));
    assert.equal(wrote, 1);
    assert.equal(JSON.parse(readFileSync(join(t.dir, '.tokenistt', 'sessions', 'antigravity.c1.jsonl'), 'utf8')).path, 'a.ts');
  });
  it('has no usage parser, since hook input has no token counts', () => {
    assert.equal(antigravity.collectUsage, undefined);
  });
});

describe('hook configuration per agent', () => {
  const target = (format: HookTarget['format'], content?: string): HookTarget => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const file = join(t.dir, 'cfg', 'hooks.json');
    if (content !== undefined) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return { scope: 'project', file, format };
  };
  const CMD = '"/n" "/tokenistt/bin/tokenistt.js" hook';

  it('Codex uses the documented hooks shape, with SessionEnd within its 3 second limit', () => {
    const t = target('codex-json');
    applyPlan(t, planConnect(codex, t, `${CMD} codex`).after);
    const cfg = JSON.parse(readFileSync(t.file, 'utf8'));
    assert.equal(cfg.hooks.Stop[0].hooks[0].type, 'command');
    assert.equal(cfg.hooks.SessionEnd[0].hooks[0].timeout, 3);
    assert.equal(cfg.hooks.PostToolUse[0].hooks[0].timeout, 5);
    assert.equal(isConnected(codex, t), true);
    applyPlan(t, planDisconnect(codex, t).after);
    assert.deepEqual(JSON.parse(readFileSync(t.file, 'utf8')), {});
  });
  it('Antigravity uses a named group, direct handlers, and a matcher only for tools', () => {
    const t = target('antigravity-json', JSON.stringify({ 'my-linter': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: 'lint' }] }] } }));
    applyPlan(t, planConnect(antigravity, t, `${CMD} antigravity`).after);
    const cfg = JSON.parse(readFileSync(t.file, 'utf8'));
    assert.equal(cfg['my-linter'].PostToolUse[0].matcher, 'run_command');
    assert.equal(cfg.tokenistt.PostToolUse[0].matcher, '*');
    assert.equal(cfg.tokenistt.PostToolUse[0].hooks[0].command, `${CMD} antigravity`);
    assert.equal(cfg.tokenistt.SessionStart[0].command, `${CMD} antigravity`);
    assert.equal(cfg.tokenistt.Stop[0].command, `${CMD} antigravity`);
    assert.equal(isConnected(antigravity, t), true);
    assert.equal(planConnect(antigravity, t, `${CMD} antigravity`).changed, false);
    applyPlan(t, planDisconnect(antigravity, t).after);
    const after = JSON.parse(readFileSync(t.file, 'utf8'));
    assert.equal(after.tokenistt, undefined);
    assert.ok(after['my-linter']);
    assert.equal(isConnected(antigravity, t), false);
  });
  it("Antigravity: leaves someone else's group that uses our name alone", () => {
    const t = target('antigravity-json', JSON.stringify({ tokenistt: { Stop: [{ command: 'their-own-script' }] } }));
    assert.throws(() => planConnect(antigravity, t, `${CMD} antigravity`), /not created by Tokenistt/);
    assert.equal(planDisconnect(antigravity, t).changed, false);
    assert.equal(isConnected(antigravity, t), false);
  });
});

describe('capability table', () => {
  it('covers every capability for every agent, each with an explanation', () => {
    for (const a of ADAPTERS) for (const k of CAPABILITY_KEYS) {
      assert.ok(a.capabilities[k], `${a.id} ${k}`);
      assert.ok(a.capabilities[k].how.length > 10, `${a.id} ${k}`);
    }
  });
  it('never claims tokens where there is no way to read them', () => {
    for (const a of ADAPTERS) assert.equal(a.capabilities.tokens.state !== 'unsupported', !!a.collectUsage, a.id);
    for (const a of ADAPTERS) if (a.capabilities.tokens.state === 'unsupported') assert.equal(a.capabilities.cost.state, 'unsupported', a.id);
  });
  it('marks unrun adapters as documented only', () => {
    assert.equal(codex.verification, 'documented');
    assert.equal(antigravity.verification, 'documented');
  });
  it('the published matrix agrees with the code', () => {
    const doc = readFileSync(new URL('../../docs/cli/AGENTS.md', import.meta.url), 'utf8');
    assert.match(doc, /OpenAI Codex \| Written from the documentation/);
    assert.match(doc, /Google Antigravity \| Written from the documentation/);
    assert.match(doc, /\| Tokens \| Best-effort: undocumented transcript \| Unsupported \| Unsupported \|/);
  });
  it('resolves short names', () => {
    assert.equal(adapterFor('claude').id, 'claude-code');
    assert.equal(adapterFor('codex').id, 'codex');
    assert.equal(adapterFor('antigravity').id, 'antigravity');
    assert.throws(() => adapterFor('cursor'), /Unknown agent/);
  });
});

describe('tokenistt agents (other agents, end to end)', () => {
  it('connects Codex and Antigravity and says what is left to do', () => {
    const t = gitRepo({ 'a.ts': 'x' });
    const home = tempDir();
    cleanups.push(t.cleanup, home.cleanup);
    const env = { TOKENISTT_HOME: home.dir };
    runCli(t.dir, ['init']);
    const c = runCli(t.dir, ['agents', 'connect', 'codex', '--yes'], { env });
    assert.equal(c.code, 0, c.err);
    assert.match(c.out, /\/hooks/);
    assert.ok(existsSync(join(t.dir, '.codex', 'hooks.json')));
    const a = runCli(t.dir, ['agents', 'connect', 'antigravity', '--yes'], { env });
    assert.equal(a.code, 0, a.err);
    assert.ok(existsSync(join(t.dir, '.agents', 'hooks.json')));
    const list = JSON.parse(runCli(t.dir, ['agents', '--json'], { env }).out).agents as Array<{ agent: string; connected: string | null; verification: string }>;
    assert.equal(list.find((x) => x.agent === 'codex')?.connected, 'project');
    assert.equal(list.find((x) => x.agent === 'antigravity')?.verification, 'documented');
    const caps = runCli(t.dir, ['agents', 'capabilities'], { env }).out;
    assert.match(caps, /not yet checked live/);
    assert.match(caps, /unsupported/);
  });
});
