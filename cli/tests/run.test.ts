import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { handleHook } from '../src/agents/hook-main.js';
import { compactCost, compactTokens, formatStatusLine, statusLineFor } from '../src/agents/statusline.js';
import type { SessionSummary } from '../src/agents/sessions.js';
import { launchSpec, resolveAgentBinary, summaryLines } from '../src/commands/run.js';
import { gitRepo, runCli, tempDir } from './helpers.js';

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  key: 'k', agent: 'claude-code', id: 'abcdef1234', branch: 'main', state: 'active', startedAt: '2026-01-01T00:00:00Z', endedAt: null, lastEventAt: '2026-01-01T00:01:00Z',
  durationMs: 61_000, endReason: null, task: null, models: [], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 18_200, requests: 2 },
  cost: { costUsd: 0.42, source: 'catalog_estimate' },
  counts: { tasks: 1, filesRead: 2, filesCreated: 1, filesModified: 2, filesDeleted: 0, commands: 3, tools: 11, errors: 0, testsPassed: 0, testsFailed: 0, testsUnknown: 0 },
  files: { read: [], created: [], modified: [], deleted: [] }, commands: [], ...over,
});

describe('status line wording', () => {
  it('is short and says what it does not know', () => {
    assert.equal(formatStatusLine(summary()), 'tokenistt · 18.2k tok · ~$0.42 · 14 tools · 3 changed');
    assert.match(formatStatusLine(summary({ tokens: null, cost: { costUsd: null, source: 'unknown' } })), /tokens n\/a · cost n\/a/);
    assert.match(formatStatusLine(summary({ cost: { costUsd: null, knownUsd: 0.1, unpricedTokens: 5, source: 'unknown' } })), /~\$0\.10\+/);
    assert.match(formatStatusLine(summary({ counts: { ...summary().counts, errors: 2 } })), /2 errors$/);
    assert.match(formatStatusLine(undefined), /waiting for the first event/);
  });
  it('compacts numbers', () => {
    assert.equal(compactTokens(999), '999');
    assert.equal(compactTokens(1_500_000), '1.5M');
    assert.equal(compactCost({ costUsd: 1.234, source: 'catalog_estimate' }), '~$1.23');
  });
});

describe('status line from real events', () => {
  let repo: ReturnType<typeof gitRepo>;
  before(() => {
    repo = gitRepo({ 'a.ts': 'export const a = 1;\n' });
    assert.equal(runCli(repo.dir, ['init']).code, 0);
  });
  after(() => repo.cleanup());

  it('counts the tools and files of the named session, and falls back to the latest', () => {
    const base = { session_id: 's1', cwd: repo.dir };
    handleHook('claude-code', JSON.stringify({ ...base, hook_event_name: 'SessionStart', source: 'startup' }));
    handleHook('claude-code', JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: join(repo.dir, 'a.ts') }, tool_response: {} }));
    handleHook('claude-code', JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 't2', tool_input: {} }));
    const line = statusLineFor(repo.dir, 's1');
    assert.match(line, /^tokenistt · /);
    assert.match(line, /1 changed/);
    assert.match(line, /1 tools/);
    assert.equal(statusLineFor(repo.dir, undefined), line);
    assert.equal(statusLineFor(repo.dir, 'no-such-session'), line);
  });
});

describe('run helpers', () => {
  it('wraps Windows .cmd shims for a shell, and nothing else', () => {
    assert.deepEqual(launchSpec('C:\\npm\\claude.cmd', ['--resume'], 'win32'), { file: '"C:\\npm\\claude.cmd"', args: ['"--resume"'], shell: true });
    assert.deepEqual(launchSpec('C:\\bin\\codex.exe', ['x'], 'win32'), { file: 'C:\\bin\\codex.exe', args: ['x'], shell: false });
    assert.deepEqual(launchSpec('/usr/bin/claude', ['x'], 'linux'), { file: '/usr/bin/claude', args: ['x'], shell: false });
  });
  it('summarises a run, or says nothing was recorded', () => {
    assert.match(summaryLines([])[0]!, /No session was recorded/);
    const lines = summaryLines([summary()]).join('\n');
    assert.match(lines, /18,200/);
    assert.match(lines, /~\$0\.4200 estimated/);
    assert.match(lines, /14 tools, 3 files changed, 2 read, 0 errors/);
    assert.match(lines, /not what you paid/);
  });
  it('finds the agent program on PATH, or reports none', () => {
    const bin = tempDir();
    try {
      const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
      writeFileSync(join(bin.dir, name), '');
      assert.ok(resolveAgentBinary('claude-code', { PATH: bin.dir })?.endsWith(name));
      assert.equal(resolveAgentBinary('codex', { PATH: bin.dir }), undefined);
    } finally { bin.cleanup(); }
  });
});

describe('tokenistt run (end to end, with a stand-in agent)', () => {
  let repo: ReturnType<typeof gitRepo>;
  let bin: ReturnType<typeof tempDir>;
  let home: ReturnType<typeof tempDir>;
  let argsFile: string;
  before(() => {
    repo = gitRepo({ 'a.ts': 'export const a = 1;\n' });
    bin = tempDir();
    home = tempDir();
    argsFile = join(bin.dir, 'args.json');
    const script = join(bin.dir, 'fake-agent.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); process.exit(7);\n`);
    if (process.platform === 'win32') writeFileSync(join(bin.dir, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
    else {
      writeFileSync(join(bin.dir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(join(bin.dir, 'claude'), 0o755);
    }
  });
  after(() => { repo.cleanup(); bin.cleanup(); home.cleanup(); });

  const env = () => ({ PATH: `${bin.dir}${delimiter}${process.env.PATH ?? ''}`, TOKENISTT_HOME: home.dir });

  it('says so when the agent is not installed', () => {
    const r = runCli(repo.dir, ['run', 'codex', '--yes'], { env: { TOKENISTT_HOME: home.dir } });
    assert.equal(r.code, 2);
    assert.match(r.err, /Codex was not found on your PATH/);
  });

  it('needs the repository set up when there is no terminal to offer setup', () => {
    const r = runCli(repo.dir, ['run', 'claude', '--yes'], { env: env() });
    assert.equal(r.code, 2);
    assert.match(r.err, /no Tokenistt project|init/i);
  });

  it('connects hooks, adds the status line, passes arguments, forwards the exit code and summarises', () => {
    assert.equal(runCli(repo.dir, ['init']).code, 0);
    const r = runCli(repo.dir, ['run', 'claude', '--yes', '--', '--resume', 'abc'], { env: env() });
    assert.equal(r.code, 7, r.err);
    assert.match(readFileSync(join(repo.dir, '.claude', 'settings.local.json'), 'utf8'), /hook claude-code/);
    const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    assert.equal(args[0], '--settings');
    assert.deepEqual(args.slice(2), ['--resume', 'abc']);
    const settings = JSON.parse(readFileSync(args[1]!, 'utf8')) as { statusLine: { type: string; command: string } };
    assert.equal(settings.statusLine.type, 'command');
    assert.match(settings.statusLine.command, /statusline$/);
    assert.match(r.out, /No session was recorded/);
  });

  it('--no-status leaves the agent\'s own settings alone', () => {
    const r = runCli(repo.dir, ['run', 'claude', '--yes', '--no-status', '--', '--resume'], { env: env() });
    assert.equal(r.code, 7, r.err);
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), ['--resume']);
    assert.ok(existsSync(join(repo.dir, '.tokenistt')));
  });
});
