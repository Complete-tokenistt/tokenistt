#!/usr/bin/env node
// End-to-end smoke test of the real docker-compose.yml: builds the stack under its own project name
// and ports, then checks the security and ops defaults. Needs Docker. Usage:
//   node scripts/smoke-compose.mjs            (or: npm run smoke:compose)
// Env: SMOKE_GATEWAY_PORT (default 3390), SMOKE_DASHBOARD_PORT (default 3391), SMOKE_KEEP=1 to leave it running.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GW = Number(process.env.SMOKE_GATEWAY_PORT) || 3390;
const DASH = Number(process.env.SMOKE_DASHBOARD_PORT) || 3391;
const project = 'tkt-smoke';
const hex = () => randomBytes(32).toString('hex');

const dir = mkdtempSync(join(tmpdir(), 'tokenistt-smoke-'));
const secrets = Object.fromEntries(
  ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'METRICS_TOKEN', 'ADMIN_SECRET', 'MASTER_KEY', 'ENCRYPTION_KEY', 'JWT_SECRET'].map((k) => [k, hex()]),
);
let env = readFileSync(join(root, '.env.example'), 'utf8');
for (const [k, v] of Object.entries(secrets)) env = env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
env = env.replace(/^GATEWAY_PORT=.*$/m, `GATEWAY_PORT=${GW}`).replace(/^DASHBOARD_PORT=.*$/m, `DASHBOARD_PORT=${DASH}`);
writeFileSync(join(dir, '.env'), env);
// Unique container names so a developer's own running stack never conflicts.
writeFileSync(
  join(dir, 'override.yml'),
  ['postgres', 'redis', 'migrate', 'gateway', 'dashboard']
    .map((s) => `  ${s}: { container_name: ${project}-${s} }`)
    .reduce((a, l) => a + l + '\n', 'services:\n'),
);

const compose = (...args) =>
  spawnSync('docker', ['compose', '-p', project, '--env-file', join(dir, '.env'), '-f', join(root, 'docker-compose.yml'), '-f', join(dir, 'override.yml'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
  if (!ok) failures++;
};
const http = async (url, init) => {
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: null, error: String(e) };
  }
};
const waitFor = async (fn, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
};
const post = (url, body) => http(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  const up = compose('up', '-d', '--build', '--wait', '--wait-timeout', '300');
  if (up.status !== 0) {
    console.error(up.stdout, up.stderr);
    throw new Error('docker compose up failed');
  }
  const g = `http://127.0.0.1:${GW}`;
  const d = `http://127.0.0.1:${DASH}`;

  // Network exposure
  // Publishers print as {URL TargetPort PublishedPort Protocol}; published port 0 means "not published".
  const published = compose('ps', '--format', '{{.Service}} {{.Publishers}}').stdout;
  const line = (svc) => published.split('\n').find((l) => l.startsWith(`${svc} `)) ?? '';
  const isPublished = (svc) => /\{\S* \d+ [1-9]\d* \w+\}/.test(line(svc));
  check('postgres is not published to the host', line('postgres') !== '' && !isPublished('postgres'), published);
  check('redis is not published to the host', line('redis') !== '' && !isPublished('redis'), published);
  check('gateway binds to loopback only', /\{127\.0\.0\.1 3000 [1-9]\d* /.test(line('gateway')), published);
  check('dashboard binds to loopback only', /\{127\.0\.0\.1 3000 [1-9]\d* /.test(line('dashboard')), published);

  // Health
  check('gateway /health is 200', (await http(`${g}/health`)).status === 200);
  check('gateway /ready is 200', (await http(`${g}/ready`)).status === 200);
  check('dashboard /api/health is 200', (await http(`${d}/api/health`)).status === 200);

  // Metrics lock
  check('/metrics without token is 401', (await http(`${g}/metrics`)).status === 401);
  check('/metrics with token is 200', (await http(`${g}/metrics`, { headers: { authorization: `Bearer ${secrets.METRICS_TOKEN}` } })).status === 200);

  // Owner bootstrap
  check('setup-status says needsSetup', (await http(`${d}/api/auth/setup-status`)).json?.needsSetup === true);
  const reg = { orgName: 'Smoke', email: 'owner@example.com', password: 'smoke-password-1' };
  check('register with a wrong setup token is 403', (await post(`${d}/api/auth/register`, { ...reg, setupToken: 'nope' })).status === 403);
  check('register with ADMIN_SECRET succeeds', (await post(`${d}/api/auth/register`, { ...reg, setupToken: secrets.ADMIN_SECRET })).status === 200);
  check('setup closes after the first owner', (await http(`${d}/api/auth/setup-status`)).json?.needsSetup === false);
  check('second register is 403', (await post(`${d}/api/auth/register`, { ...reg, email: 'x@example.com', setupToken: secrets.ADMIN_SECRET })).status === 403);
  check('login works', (await post(`${d}/api/auth/login`, { email: reg.email, password: reg.password })).status === 200);
  check('wrong password is 401', (await post(`${d}/api/auth/login`, { email: reg.email, password: 'wrong-password' })).status === 401);

  // Concurrent migrators and re-run are safe
  const runs = await Promise.all([1, 2].map(() => Promise.resolve(compose('run', '--rm', '--no-deps', '-T', 'migrate'))));
  check('two concurrent migrate runs both succeed', runs.every((r) => r.status === 0), runs.map((r) => r.stderr.slice(-200)).join(' | '));

  // Database outage is visible, and recovery works
  compose('stop', 'postgres');
  check('gateway /health is 503 with the database down', await waitFor(async () => (await http(`${g}/health`)).status === 503, 30000));
  check('dashboard /api/health is 503 with the database down', await waitFor(async () => (await http(`${d}/api/health`)).status === 503, 30000));
  compose('start', 'postgres');
  check('gateway /health recovers', await waitFor(async () => (await http(`${g}/health`)).status === 200, 60000));
} catch (e) {
  console.error(String(e));
  failures++;
} finally {
  if (process.env.SMOKE_KEEP !== '1') {
    compose('down', '-v', '--remove-orphans');
    rmSync(dir, { recursive: true, force: true });
  } else {
    console.log(`Left running (project ${project}); env in ${dir}`);
  }
}

console.log(failures === 0 ? '\nAll compose smoke checks passed.' : `\n${failures} compose smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
