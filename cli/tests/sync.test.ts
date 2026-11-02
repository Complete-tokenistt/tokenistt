import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ApiClient } from '../src/api/client.js';
import { baseUrlHost, handleHook } from '../src/agents/hook-main.js';
import { refresh } from '../src/agents/sessions.js';
import { indexProject } from '../src/graph/indexer.js';
import { remember } from '../src/memory/store.js';
import { repoInfo } from '../src/project/git.js';
import { openDatabase } from '../src/store/db.js';
import { initProject, readProjectConfig } from '../src/store/project.js';
import { buildPayload, runSync, sendLedger } from '../src/sync/sync.js';
import { fakeGateway, gitRepo, runCli } from './helpers.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });
const KEY = 'tktt_live_good_key_0123456789abcdef';

function setup(ledger = false) {
  const t = gitRepo({ 'src/a.ts': 'export function a() {}', 'package.json': JSON.stringify({ name: 'demo' }) });
  cleanups.push(t.cleanup);
  const { project } = initProject(repoInfo(t.dir)!);
  project.config.sync.ledger = ledger;
  const db = openDatabase(t.dir);
  cleanups.push(() => db.close());
  return { t, db, project };
}
const usage = (id: string, input = 1) => `${JSON.stringify({ type: 'assistant', requestId: id, timestamp: '2026-11-02T10:00:00.000Z', message: { model: 'claude-x', usage: { input_tokens: input, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } })}\n`;
function session(dir: string, id = 'sess1', transcriptLines = usage('r1')) {
  const transcript = join(dir, '.tokenistt', 'cache', `${id}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, transcriptLines);
  handleHook('claude-code', JSON.stringify({ session_id: id, hook_event_name: 'PostToolUse', cwd: dir, transcript_path: transcript, tool_name: 'Edit', tool_use_id: `${id}-x`, tool_input: { file_path: join(dir, 'src/a.ts'), new_string: 'SOURCE_TEXT' } }));
  return transcript;
}
async function gateway() {
  const gw = await fakeGateway({
    'POST /v1/sync': { json: { ok: true } },
    'POST /v1/ingest/events': (r) => ({ json: { results: (JSON.parse(r.body).events as unknown[]).map(() => ({ status: 'accepted' })) } }),
  });
  cleanups.push(() => gw.close());
  return gw;
}
const client = (url: string) => new ApiClient({ apiUrl: url, apiKey: KEY }, { baseDelayMs: 1, maxAttempts: 2 });

describe('what sync sends', () => {
  it('sends summaries with repo-relative paths, and nothing private', async () => {
    const { t, db, project } = setup();
    const transcript = session(t.dir);
    await indexProject(project, db);
    remember(db, project.config.projectId, { category: 'OPEN_TASKS', content: 'Do it', sourceKind: 'user', sourceRef: 'me' });
    const { payload } = buildPayload(project, db);
    const text = JSON.stringify(payload);
    assert.doesNotMatch(text, /SOURCE_TEXT/);
    assert.equal(text.includes(t.dir.replaceAll('\\', '\\\\')), false, 'no machine paths');
    assert.equal(text.includes(transcript.replaceAll('\\', '\\\\')), false);
    const p = payload as any;
    assert.equal(p.schema_version, 1);
    assert.equal(p.repository.project_key, project.config.projectId);
    assert.deepEqual(p.sessions[0].changed_files, ['src/a.ts']);
    assert.equal(p.sessions[0].cost_source, 'unknown');
    assert.equal(p.sessions[0].cost_usd, null);
    assert.equal(p.memories[0].content, 'Do it');
    assert.equal(p.graph.stats.nodes.file, 2);
    assert.equal(p.graph.modules[0].name, 'demo');
  });
  it('sends only what changed, and resends after a failure', async () => {
    const { t, db, project } = setup();
    session(t.dir);
    const down = await fakeGateway({ 'POST /v1/sync': { status: 500, json: { error: { message: 'x' } } } });
    await assert.rejects(runSync(project, db, client(down.url)));
    await down.close();
    assert.equal(buildPayload(project, db).sessions, 1, 'nothing was lost');
    const gw = await gateway();
    assert.equal((await runSync(project, db, client(gw.url))).sessions, 1);
    const next = buildPayload(project, db);
    assert.equal(next.sessions, 0);
    assert.equal(next.memories, 0);
    await new Promise((r) => setTimeout(r, 5));
    handleHook('claude-code', JSON.stringify({ session_id: 'sess1', hook_event_name: 'Stop', cwd: t.dir }));
    refresh(t.dir, db);
    assert.equal(buildPayload(project, db).sessions, 1, 'a session with new events goes again');
  });
  it('sends the graph once per build', async () => {
    const { db, project } = setup();
    await indexProject(project, db);
    const gw = await gateway();
    assert.equal((await runSync(project, db, client(gw.url))).graph, true);
    assert.equal(buildPayload(project, db).graph, false);
    await indexProject(project, db, { now: () => new Date(Date.now() + 1000) });
    assert.equal(buildPayload(project, db).graph, true);
  });
  it('treats an unreachable gateway as retry-later, moving no cursor', async () => {
    const { t, db, project } = setup();
    session(t.dir);
    await assert.rejects(runSync(project, db, client('http://127.0.0.1:9')), /Could not reach/);
    assert.equal(buildPayload(project, db).sessions, 1);
  });
});

describe('the ledger, opt-in', () => {
  it('is not touched unless opted in', async () => {
    const { t, db, project } = setup(false);
    session(t.dir);
    const gw = await gateway();
    assert.equal((await runSync(project, db, client(gw.url))).ledgerEvents, null);
    assert.equal(gw.requests.some((r) => r.path === '/v1/ingest/events'), false);
  });
  it('sends each API request once, with no cost, so the gateway prices it', async () => {
    const { t, db, project } = setup(true);
    session(t.dir, 'sess1', usage('r1') + usage('r2'));
    const gw = await gateway();
    const r = await runSync(project, db, client(gw.url));
    assert.equal(r.ledgerEvents?.accepted, 2);
    const body = JSON.parse(gw.requests.find((x) => x.path === '/v1/ingest/events')?.body ?? '{}');
    assert.equal(body.events[0].provider, 'anthropic');
    assert.equal(body.events[0].model, 'claude-x');
    assert.equal(body.events[0].input_tokens, 1);
    assert.equal(body.events[0].cached_tokens, 3);
    assert.equal(body.events[0].cache_creation_tokens, 4);
    assert.equal('cost_usd' in body.events[0], false);
    assert.equal(body.events[0].attribution.session, 'sess1');
    assert.equal((await sendLedger(project, db, client(gw.url))).accepted, 0, 'not sent twice');
  });
  it('skips a session that ran through this gateway, so it is not counted twice', async () => {
    const { t, db, project } = setup(true);
    const gw = await gateway();
    const previous = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `${gw.url}/v1`;
    try {
      session(t.dir, 'proxied');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous;
    }
    const r = await runSync(project, db, client(gw.url));
    assert.equal(r.ledgerEvents?.skippedProxied, 1);
    assert.equal(r.ledgerEvents?.accepted, 0);
  });
  it('a different proxy is not this gateway, so that usage is still sent', async () => {
    const { t, db, project } = setup(true);
    const gw = await gateway();
    const previous = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'https://other-proxy.example.com/v1';
    try {
      session(t.dir, 'elsewhere');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous;
    }
    assert.equal((await runSync(project, db, client(gw.url))).ledgerEvents?.accepted, 1);
  });
  it('keeps only the host of a base URL, never credentials in it', () => {
    assert.equal(baseUrlHost({ ANTHROPIC_BASE_URL: 'https://user:secret@proxy.example.com/v1' }), 'proxy.example.com');
    assert.equal(baseUrlHost({ OPENAI_BASE_URL: 'not a url' }), undefined);
    assert.equal(baseUrlHost({}), undefined);
  });
});

describe('tokenistt sync (end to end)', () => {
  const repo = () => {
    const t = gitRepo({ 'a.ts': 'x' });
    cleanups.push(t.cleanup);
    runCli(t.dir, ['init']);
    return t;
  };
  it('is off by default, and dry-run sends nothing', async () => {
    const t = repo();
    session(t.dir);
    const gw = await gateway();
    const env = { TOKENISTT_API_URL: gw.url, TOKENISTT_API_KEY: KEY };
    const off = runCli(t.dir, ['sync'], { env });
    assert.equal(off.code, 2);
    assert.match(off.err, /Sync is off/);
    const dry = runCli(t.dir, ['sync', '--dry-run'], { env });
    assert.equal(dry.code, 0, dry.err);
    assert.equal(JSON.parse(dry.out).schema_version, 1);
    assert.equal(gw.requests.length, 0);
  });
  it('enable writes the config, then sends; disable stops it; the ledger warns', async () => {
    const t = repo();
    session(t.dir);
    const gw = await fakeGateway({ 'POST /v1/sync': { json: { ok: true } } });
    cleanups.push(() => gw.close());
    const env = { TOKENISTT_API_URL: gw.url, TOKENISTT_API_KEY: KEY };
    const r = await runCliAsync(t.dir, ['sync', '--enable', '--json'], env);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).sessions, 1);
    assert.ok(gw.requests.some((x) => x.path === '/v1/sync'));
    assert.equal(readProjectConfig(t.dir)?.sync.enabled, true);
    assert.equal(runCli(t.dir, ['sync', '--disable'], { env }).code, 0);
    assert.equal(readProjectConfig(t.dir)?.sync.enabled, false);
    assert.match(readFileSync(join(t.dir, '.tokenistt', 'config.json'), 'utf8'), /"enabled": false/);
    assert.equal(runCli(t.dir, ['sync', '--enable', '--disable']).code, 2);
    const ledger = runCli(t.dir, ['sync', '--ledger', '--dry-run'], { env });
    assert.match(ledger.err, /billed per token/);
    assert.equal(readProjectConfig(t.dir)?.sync.ledger, true);
    assert.equal(runCli(t.dir, ['sync', '--no-ledger', '--dry-run'], { env }).code, 0);
    assert.equal(readProjectConfig(t.dir)?.sync.ledger, false);
  });
  it('needs a key', () => {
    const t = repo();
    assert.equal(runCli(t.dir, ['sync', '--enable']).code, 3);
  });
});

/** The fake gateway runs in this process, so a CLI that talks to it must not block the event loop. */
async function runCliAsync(cwd: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const { spawn } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', tsx, main, ...args], { cwd, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NO_COLOR: '1', TOKENISTT_CONFIG_DIR: join(cwd, '.test-config'), ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    p.stdin.end();
  });
}
