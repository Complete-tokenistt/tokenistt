/**
 * final_live_test2.mjs
 * Creates a properly-formatted virtual key and fires a live request.
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env')) config();
import pg from 'pg';
const { Pool } = pg;
import { createHmac, randomBytes } from 'node:crypto';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const GW = 'http://localhost:4000';
const ok  = (msg) => console.log(`  ✓ ${msg}`);
const err = (msg) => console.error(`  ✗ ${msg}`);
const hdr = (t)   => console.log(`\n── ${t} ──`);

// Build a token that strictly matches ^Bearer tktt_live_(\w+)_(\w+)_(\w+)$
// workspace = alphanumeric only, user = alphanumeric only, hash = hex (alphanumeric)
function buildToken(workspace, user) {
  const hash = randomBytes(12).toString('hex'); // 24 hex chars — strictly \w+
  return `tktt_live_${workspace}_${user}_${hash}`;
}

function sha256(s) {
  return createHmac('sha256', 'tokenistt-key-hash-secret').update(s).digest('hex');
}

hdr('1 · Create properly-formatted virtual key');

const { encryptApiKey } = await import('./dist/services/vault.js');

const rawToken = buildToken('acmews', 'smoketest');
const keyHash  = sha256(rawToken);
const prefix   = rawToken.slice(0, rawToken.lastIndexOf('_') - 8) + '...';
const encKey   = encryptApiKey(process.env.OPENAI_API_KEY, '1');

ok(`Token: ${rawToken.slice(0, 45)}...`);
ok(`Hash:  ${keyHash.slice(0, 20)}...`);

// Clean up any previous smoke test keys first
await pool.query(`DELETE FROM virtual_keys WHERE name = 'Smoke Test Live 2'`).catch(() => {});

await pool.query(`
  INSERT INTO virtual_keys
    (organization_id, name, key_prefix, key_hash, status, budget_cap_usd, budget_period, metadata)
  VALUES
    (1, 'Smoke Test Live 2', $1, $2, 'active', 5.00, 'monthly',
     jsonb_build_object(
       'real_api_key',          $3::text,
       'enforcement_mode',      'hard_cap',
       'rate_limit_per_minute', 100
     ))
`, [prefix, keyHash, encKey]);
ok('Inserted key into DB');

hdr('2 · Live AI request');

const txBefore   = await pool.query(`SELECT COUNT(*) c FROM transactions`).then(r=>parseInt(r.rows[0].c));
const costBefore = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::float t FROM transactions WHERE status='success'`).then(r=>parseFloat(r.rows[0].t));
ok(`Before: ${txBefore} transactions | $${costBefore.toFixed(6)} total spend`);

const t0 = Date.now();
const resp = await fetch(`${GW}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${rawToken}`
  },
  body: JSON.stringify({
    model: 'llama-3.1-8b-instant',
    messages: [{ role: 'user', content: 'Reply with exactly: "FinOps live OK"' }],
    max_tokens: 15,
    temperature: 0
  }),
  signal: AbortSignal.timeout(30000)
}).catch(e => ({ status: 0, headers: new Map(), json: async()=>({ error: e.message }) }));

const latency = Date.now() - t0;
const body    = await resp.json();

if (resp.status === 200) {
  const reply  = body.choices?.[0]?.message?.content?.trim() ?? '';
  const cost   = body._tokenistt?.cost_usd ?? resp.headers?.get?.('x-tokenistt-cost') ?? '?';
  const reqId  = body._tokenistt?.request_id ?? '?';

  ok(`HTTP 200 | ${latency}ms`);
  ok(`Reply: "${reply}"`);
  ok(`Cost: $${cost}`);
  ok(`Request ID: ${reqId}`);
  ok(`Prompt tokens: ${body.usage?.prompt_tokens} | Completion: ${body.usage?.completion_tokens}`);

  hdr('3 · Ledger check');
  await new Promise(r => setTimeout(r, 2000));

  const txAfter   = await pool.query(`SELECT COUNT(*) c FROM transactions`).then(r=>parseInt(r.rows[0].c));
  const costAfter = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::float t FROM transactions WHERE status='success'`).then(r=>parseFloat(r.rows[0].t));

  if (txAfter > txBefore) {
    ok(`Transactions: ${txBefore} → ${txAfter} ✓`);
    ok(`Spend: $${costBefore.toFixed(6)} → $${costAfter.toFixed(6)} (+$${(costAfter-costBefore).toFixed(6)})`);

    const row = await pool.query(`
      SELECT provider, model, cost_usd::float, input_cost_usd::float, output_cost_usd::float,
             prompt_tokens, completion_tokens, status, organization_id, cost_center
      FROM transactions ORDER BY created_at DESC LIMIT 1
    `).then(r=>r.rows[0]);

    ok(`Provider: ${row.provider} | Model: ${row.model}`);
    ok(`cost_usd: $${row.cost_usd.toFixed(8)} (input=$${row.input_cost_usd.toFixed(8)} + output=$${row.output_cost_usd.toFixed(8)})`);
    ok(`Org: ${row.organization_id} | cost_center: ${row.cost_center} | status: ${row.status}`);

    const gap = Math.abs(row.cost_usd - (row.input_cost_usd + row.output_cost_usd));
    ok(`Reconciliation gap: $${gap.toFixed(8)} ${gap < 0.000001 ? '✓' : '⚠ check rounding'}`);
  } else {
    err(`No new transaction in DB after 2s (count stayed at ${txBefore})`);
  }
} else {
  err(`${resp.status}: ${JSON.stringify(body).slice(0, 200)}`);
}

// Cleanup
await pool.query(`DELETE FROM virtual_keys WHERE name = 'Smoke Test Live 2'`);
ok('Cleaned up test key');

hdr('4 · Dashboard API check');
try {
  const r  = await fetch('http://localhost:3000/', { signal: AbortSignal.timeout(6000) });
  ok(`Homepage: HTTP ${r.status}`);
} catch(e) { err(`Dashboard: ${e.message}`); }

hdr('5 · Final state');
const fin = await pool.query(`
  SELECT
    (SELECT COUNT(*) FROM transactions WHERE status='success')::int AS txns,
    (SELECT COALESCE(SUM(cost_usd),0)::float FROM transactions WHERE status='success') AS spend,
    (SELECT COUNT(*) FROM virtual_keys WHERE status='active')::int AS keys
`).then(r=>r.rows[0]);
ok(`Transactions: ${fin.txns} | Spend: $${parseFloat(fin.spend).toFixed(6)} | Active keys: ${fin.keys}`);

await pool.end();

console.log(`
╔════════════════════════════════════════════════╗
║     Tokenistt FinOps Platform — RUNNING        ║
╠════════════════════════════════════════════════╣
║  Gateway:    http://localhost:4000             ║
║  Dashboard:  http://localhost:3000             ║
╚════════════════════════════════════════════════╝
`);
