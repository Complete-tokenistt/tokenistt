#!/usr/bin/env node
/**
 * End-to-end check of the real `tokenistt` CLI against a real gateway (no fake server, no real providers).
 *
 *   DATABASE_URL=postgres://tokenistt:tokenistt@localhost:5433/tokenistt \
 *   REDIS_URL=redis://localhost:6380 npm run test:e2e -w cli
 *
 * Boots apps/gateway with MOCK_PROVIDER=1, then drives the CLI as a child process:
 * login -> a request through the gateway -> usage/cost match the database -> policy apply/test
 * (and the gateway really blocks) -> init + sync -> a second organization sees none of it.
 * Needs Node 22.13+ (node:sqlite) and a migrated Postgres.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.log(`SKIPPED: CLI e2e needs Node 22.13+ (running ${process.versions.node}).`);
  process.exit(0);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..');
const gatewayRoot = join(cliRoot, '..', 'apps', 'gateway');
const PORT = process.env.CLI_E2E_PORT || '3556';
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_SECRET = 'cli-e2e-admin-secret-0123456789abcdef0123456789';
const JWT_SECRET = 'cli-e2e-jwt-secret-0123456789abcdef0123456789abcdef';
const tmp = mkdtempSync(join(tmpdir(), 'tokenistt-cli-e2e-'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${ok ? '' : `  → ${detail}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  cwd: gatewayRoot,
  env: {
    ...process.env, PORT, MOCK_PROVIDER: '1', DEFAULT_PROVIDER: 'mock', ADMIN_SECRET, JWT_SECRET,
    MASTER_KEY: 'cli-e2e-master-key-0123456789abcdef0123456789abcdef',
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6380',
    TX_QUEUE_FILE: join(tmp, 'tx.jsonl'), AUDIT_QUEUE_FILE: join(tmp, 'audit.jsonl'), NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const orgIds = [];

const jwt = (orgId) => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub: 'cli-e2e', orgId, role: 'admin', email: 'cli-e2e@example.com', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${body}.${createHmac('sha256', JWT_SECRET).update(body).digest('base64url')}`;
};

/** Runs the real CLI. `env` is explicit so nothing leaks in from the developer's machine. */
function cli(args, { cwd = cliRoot, stdin = '', config, env = {} } = {}) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'main.ts'), ...args], {
    cwd, input: stdin, encoding: 'utf8', timeout: 90_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TOKENISTT_CONFIG_DIR: config, TOKENISTT_API_URL: BASE, NO_COLOR: '1', ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr, json };
}

async function chat(token, body) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
}

async function newOrg(label) {
  const sfx = randomUUID().slice(0, 8);
  const id = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id::text`, [`CLI E2E ${label} ${sfx}`, `cli-e2e-${label}-${sfx}`])).rows[0].id;
  orgIds.push(id);
  const ws = (await pool.query(`INSERT INTO workspaces (organization_id, name, cost_center) VALUES ($1,'E2E','CC-E2E') RETURNING id::text`, [id])).rows[0].id;
  return { id, ws };
}

async function main() {
  console.log('Booting gateway…');
  let healthy = false;
  for (let i = 0; i < 80 && !healthy; i++) {
    try { healthy = (await fetch(`${BASE}/health`)).ok; } catch { /* starting */ }
    if (server.exitCode !== null) break;
    if (!healthy) await sleep(250);
  }
  if (!healthy) throw new Error('gateway did not become healthy');

  const a = await newOrg('a');
  const b = await newOrg('b');
  const keyRes = await fetch(`${BASE}/v1/admin/keys?organization_id=${a.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN_SECRET }, body: JSON.stringify({ name: 'cli-e2e', workspace_id: a.ws, budgetCapUsd: 50 }),
  });
  const key = (await keyRes.json()).token;
  check('setup: virtual key created', /^tktt_live_/.test(key ?? ''));

  const cfgA = join(tmp, 'config-a');
  const cfgB = join(tmp, 'config-b');
  mkdirSync(cfgA); mkdirSync(cfgB);

  console.log('\nLogin');
  let r = cli(['login', '--token-stdin'], { stdin: `${jwt(a.id)}\n`, config: cfgA });
  check('login validates the token against the gateway', r.code === 0 && /Logged in/.test(r.out), r.err || r.out);
  r = cli(['auth', 'whoami', '--json'], { config: cfgA });
  check('whoami reports the right organization', r.code === 0 && String(r.json?.organization?.id) === a.id, r.err || r.out);
  r = cli(['doctor', '--json'], { config: cfgA, env: { TOKENISTT_API_KEY: key } });
  check('doctor runs against the live gateway', r.code === 0 || r.code === 1, r.err || r.out); // ran to completion; warnings are fine

  console.log('\nUsage and cost match the database');
  const calls = [
    await chat(key, { model: 'mock:echo', messages: [{ role: 'user', content: 'cli e2e one' }] }),
    await chat(key, { model: 'mock:echo', messages: [{ role: 'user', content: 'cli e2e two' }] }),
  ];
  check('requests go through the gateway', calls.every((c) => c.status === 200), JSON.stringify(calls.map((c) => c.status)));
  await sleep(1000); // the event logger is async
  const db = (await pool.query(`SELECT count(*)::int AS n, coalesce(sum(cost_usd),0)::float AS cost FROM transactions WHERE organization_id = $1`, [a.id])).rows[0];
  r = cli(['usage', '--json', '--days', '1'], { config: cfgA });
  const requests = (r.json?.rows ?? []).reduce((s, x) => s + Number(x.requests), 0);
  check('usage request count equals transactions in the database', r.code === 0 && requests === db.n && db.n >= 2, `cli=${requests} db=${db.n} ${r.err}`);
  r = cli(['cost', '--json', '--days', '1'], { config: cfgA });
  const cost = (r.json?.rows ?? []).reduce((s, x) => s + Number(x.cost_usd), 0);
  check('cost total equals the database total', r.code === 0 && Math.abs(cost - db.cost) < 1e-6 && db.cost > 0, `cli=${cost} db=${db.cost} ${r.err}`);
  r = cli(['cost', '--csv', '--days', '1'], { config: cfgA });
  check('cost --csv writes a header and rows', r.code === 0 && /^model,requests/.test(r.out), r.out.slice(0, 200));

  console.log('\nPolicy');
  const file = join(tmp, 'policies.yml');
  writeFileSync(file, 'policies:\n  - name: cli-e2e allow-list\n    conditions:\n      model_not_in: ["mock:echo"]\n    actions:\n      effect: block\n      message: not allowed by cli-e2e\n');
  r = cli(['policy', 'apply', file, '--json'], { config: cfgA });
  check('apply without --yes is a dry run and creates nothing', r.code === 0 && r.json?.dry_run === true, r.err || r.out);
  r = cli(['policy', 'apply', file, '--yes', '--json'], { config: cfgA });
  check('apply --yes creates the policy', r.code === 0 && r.json?.created?.length === 1, r.err || r.out);
  r = cli(['policy', 'apply', file, '--yes', '--json'], { config: cfgA });
  check('applying again leaves it unchanged (idempotent)', r.code === 0 && r.json?.created?.length === 0 && r.json?.unchanged?.length === 1, r.err || r.out);
  await sleep(300);
  r = cli(['policy', 'test', '--model', 'mock:blocked', '--json'], { config: cfgA });
  check('policy test exits 5 for a stopped request', r.code === 5 && r.json?.allowed === false, `${r.code} ${r.err || r.out}`);
  r = cli(['policy', 'test', '--model', 'mock:echo', '--json'], { config: cfgA });
  check('policy test exits 0 for an allowed request', r.code === 0 && r.json?.allowed === true, `${r.code} ${r.err || r.out}`);
  const blocked = await chat(key, { model: 'mock:blocked', messages: [{ role: 'user', content: 'x' }] });
  check('the gateway really blocks what policy test said it would', blocked.status >= 400 && blocked.status < 500, `status ${blocked.status}`);

  console.log('\nInit and sync');
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'index.js'), 'export const hello = () => "hi";\n');
  const git = (...args) => spawnSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init');
  r = cli(['init', '--json'], { cwd: repo, config: cfgA });
  check('init works in a fresh git repository', r.code === 0 && r.json?.created === true, r.err || r.out);
  r = cli(['sync', '--json'], { cwd: repo, config: cfgA, env: { TOKENISTT_API_KEY: key } });
  check('sync is refused until it is turned on', r.code === 2, `${r.code} ${r.err}`);
  r = cli(['sync', '--enable', '--json'], { cwd: repo, config: cfgA, env: { TOKENISTT_API_KEY: key } });
  check('sync --enable sends the repository summary', r.code === 0, `${r.code} ${r.err || r.out}`);

  console.log('\nTenant isolation');
  r = cli(['login', '--token-stdin'], { stdin: `${jwt(b.id)}\n`, config: cfgB });
  check('second organization can log in', r.code === 0, r.err || r.out);
  r = cli(['usage', '--json', '--days', '1'], { config: cfgB });
  check('second organization sees none of the first one’s usage', r.code === 0 && (r.json?.rows ?? []).length === 0, r.err || JSON.stringify(r.json?.rows));
  r = cli(['policy', '--json'], { config: cfgB });
  check('second organization sees none of the first one’s policies', r.code === 0 && (r.json?.policies ?? []).length === 0, r.err || r.out);
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error('\nCLI e2e aborted:', err.message);
} finally {
  server.kill();
  await sleep(300);
  try {
    for (const id of orgIds) {
      for (const t of ['approval_requests', 'budget_alerts', 'budgets', 'policies', 'routing_rules', 'provider_keys', 'transactions', 'virtual_keys', 'workspaces']) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id = $1`, [id]);
      }
    }
  } catch { /* best effort */ }
  await pool.end();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

const bad = results.filter((x) => !x.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length || failed) {
  console.log('Gateway log tail:\n' + serverLog.slice(-1500));
  process.exit(1);
}
