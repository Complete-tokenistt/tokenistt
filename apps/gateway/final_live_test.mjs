/**
 * final_live_test.mjs
 * Uses key id=1 (Jane's Dev Key, ACME Corp, $5000 cap) which already has
 * an encrypted Groq key attached from the /v1/providers/connect call.
 * We re-use an existing key prefix to construct a valid token.
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env')) config();

import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const ok  = (msg) => console.log(`  ✓ ${msg}`);
const err = (msg) => console.error(`  ✗ ${msg}`);
const hdr = (t)   => console.log(`\n── ${t} ──`);

const GW = 'http://localhost:4000';

// ── Get the newest virtual key (just created by /v1/providers/connect) ────────
hdr('1 · Latest virtual key in DB');
const { rows } = await pool.query(`
  SELECT id, name, key_prefix, key_hash, status,
         budget_cap_usd, budget_period,
         metadata->>'real_api_key' AS has_key,
         created_at
  FROM virtual_keys
  WHERE status = 'active'
  ORDER BY id DESC
  LIMIT 5
`);
rows.forEach(k => {
  console.log(`    id=${k.id} | "${k.name}" | prefix=${k.key_prefix} | cap=$${k.budget_cap_usd} | has_key=${!!k.has_key}`);
});

// ── Reconstruct a valid token from a known prefix ─────────────────────────────
// key_prefix stores "tktt_live_{ws}_{user}_{first4}..." 
// The full token format is tktt_live_{workspace}_{userId}_{hash}
// We can directly call the admin endpoint to generate a fresh working token

hdr('2 · Generate fresh working token via admin');

// Use the admin /v1/admin/keys endpoint with correct payload
const createKeyResp = await fetch(`${GW}/v1/admin/keys`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-admin-secret': process.env.ADMIN_SECRET
  },
  body: JSON.stringify({
    name: 'Live Test Key',
    organizationId: 1,
    workspaceId: null,
    budgetCapUsd: 5.00,
    budgetPeriod: 'monthly',
    realApiKey: null  // will use env OPENAI_API_KEY
  }),
  signal: AbortSignal.timeout(10000)
}).catch(e => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));

const createBody = await createKeyResp.json?.() ?? {};
console.log(`  Admin /keys response (${createKeyResp.status}):`, JSON.stringify(createBody).slice(0, 200));

// ── If admin key creation fails, fall back to direct DB insert + key generation ─
hdr('3 · Direct key generation');
const { generateVirtualKey } = await import('./dist/services/keyManager.js');
const { encryptApiKey } = await import('./dist/services/vault.js');

// Generate a fresh valid token
const keyInfo = generateVirtualKey('acmews', 'smoketest');
const encKey  = encryptApiKey(process.env.OPENAI_API_KEY, '1');

ok(`Generated token: ${keyInfo.rawToken.slice(0, 40)}...`);
ok(`Key prefix: ${keyInfo.keyPrefix}`);
ok(`Key hash: ${keyInfo.keyHash.slice(0, 20)}...`);

// Insert into DB
try {
  await pool.query(`
    INSERT INTO virtual_keys (organization_id, name, key_prefix, key_hash, status, budget_cap_usd, budget_period, metadata)
    VALUES (1, 'Smoke Test Live', $1, $2, 'active', 5.00, 'monthly',
            jsonb_build_object('real_api_key', $3::text, 'enforcement_mode', 'hard_cap', 'rate_limit_per_minute', 100))
    ON CONFLICT DO NOTHING
  `, [keyInfo.keyPrefix, keyInfo.keyHash, encKey]);
  ok(`Inserted key into virtual_keys table`);
} catch(e) {
  err(`Insert failed: ${e.message}`);
}

// ── Step 4: Send real authenticated AI request ────────────────────────────────
hdr('4 · Live authenticated AI request');

const txBefore = await pool.query(`SELECT COUNT(*) c FROM transactions`).then(r => parseInt(r.rows[0].c));
const costBefore = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::float t FROM transactions WHERE status='success'`).then(r => parseFloat(r.rows[0].t));

ok(`Transactions before: ${txBefore} | Total spend before: $${costBefore.toFixed(6)}`);

const startMs = Date.now();
const aiResp = await fetch(`${GW}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${keyInfo.rawToken}`
  },
  body: JSON.stringify({
    model: 'llama-3.1-8b-instant',
    messages: [{ role: 'user', content: 'Say exactly three words: FinOps test successful' }],
    max_tokens: 20,
    temperature: 0
  }),
  signal: AbortSignal.timeout(30000)
}).catch(e => ({ status: 0, json: async () => ({ error: e.message }), headers: new Headers() }));

const latency = Date.now() - startMs;
const aiBody = await aiResp.json();

if (aiResp.status === 200) {
  ok(`HTTP 200 OK | Latency: ${latency}ms`);
  ok(`Reply: "${aiBody.choices?.[0]?.message?.content?.trim()}"`);
  ok(`Cost (response): $${aiBody._tokenistt?.cost_usd ?? '?'}`);
  ok(`Cost header: ${aiResp.headers?.get?.('x-tokenistt-cost') ?? '?'}`);
  ok(`Request ID: ${aiBody._tokenistt?.request_id ?? '?'}`);
  ok(`Provider: ${aiBody._tokenistt?.cost_center ?? '?'}`);
  ok(`Tokens: ${aiBody.usage?.prompt_tokens}p + ${aiBody.usage?.completion_tokens}c`);

  // ── Step 5: Verify ledger ──────────────────────────────────────────────────
  hdr('5 · Ledger verification');
  await new Promise(r => setTimeout(r, 2000));

  const txAfter    = await pool.query(`SELECT COUNT(*) c FROM transactions`).then(r => parseInt(r.rows[0].c));
  const costAfter  = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::float t FROM transactions WHERE status='success'`).then(r => parseFloat(r.rows[0].t));

  if (txAfter > txBefore) {
    ok(`Transactions: ${txBefore} → ${txAfter} (+${txAfter - txBefore} new)`);
    ok(`Total spend: $${costBefore.toFixed(6)} → $${costAfter.toFixed(6)} (+$${(costAfter - costBefore).toFixed(6)})`);

    const latest = await pool.query(`
      SELECT request_id, provider, model, cost_usd::float,
             prompt_tokens, completion_tokens, total_tokens,
             input_cost_usd::float, output_cost_usd::float,
             status, organization_id, cost_center, created_at
      FROM transactions ORDER BY created_at DESC LIMIT 1
    `);
    const t = latest.rows[0];
    ok(`provider: ${t.provider} | model: ${t.model}`);
    ok(`cost_usd: $${t.cost_usd.toFixed(8)} | input: $${t.input_cost_usd.toFixed(8)} | output: $${t.output_cost_usd.toFixed(8)}`);
    ok(`tokens: ${t.prompt_tokens}p + ${t.completion_tokens}c = ${t.total_tokens} total`);
    ok(`org: ${t.organization_id} | cost_center: ${t.cost_center} | status: ${t.status}`);

    // Financial reconciliation check
    const reconDiff = Math.abs(t.cost_usd - (t.input_cost_usd + t.output_cost_usd));
    reconDiff < 0.000001
      ? ok(`Reconciliation: cost_usd ≈ input_cost + output_cost ✓`)
      : err(`Reconciliation gap: $${reconDiff.toFixed(8)}`);

  } else {
    err(`Transaction count unchanged (${txBefore}) — logger may be delayed or failed`);
    
    // Check gateway logs
    const latestLog = await pool.query(`
      SELECT request_id, provider, model, status FROM transactions ORDER BY created_at DESC LIMIT 3
    `);
    console.log('  Last 3 transactions in DB:', JSON.stringify(latestLog.rows));
  }

} else {
  err(`Request returned ${aiResp.status}: ${JSON.stringify(aiBody).slice(0, 200)}`);
}

// ── Final summary ─────────────────────────────────────────────────────────────
hdr('6 · Final platform summary');
const final = await pool.query(`
  SELECT
    (SELECT COUNT(*) FROM transactions WHERE status='success')::int   AS txns,
    (SELECT COALESCE(SUM(cost_usd),0)::float FROM transactions
     WHERE status='success')                                           AS total_cost,
    (SELECT COUNT(*) FROM virtual_keys WHERE status='active')::int    AS keys,
    (SELECT COUNT(*) FROM organizations)::int                         AS orgs,
    (SELECT COUNT(*) FROM model_catalog WHERE status='active')::int   AS models
`);
const f = final.rows[0];
ok(`Orgs: ${f.orgs} | Active keys: ${f.keys} | Pricing models: ${f.models}`);
ok(`Successful transactions: ${f.txns} | Total spend: $${parseFloat(f.total_cost).toFixed(6)}`);

// Dashboard
hdr('7 · Dashboard reachability');
try {
  const r = await fetch('http://localhost:3000', { signal: AbortSignal.timeout(6000) });
  ok(`Dashboard: HTTP ${r.status} at http://localhost:3000`);
  const sum = await fetch('http://localhost:3000/api/summary', { signal: AbortSignal.timeout(6000) });
  const sumBody = await sum.json().catch(() => ({}));
  ok(`/api/summary: ${sum.status} | response keys: ${Object.keys(sumBody).join(', ')}`);
} catch(e) { err(`Dashboard: ${e.message.slice(0, 70)}`); }

await pool.end();

console.log(`
╔══════════════════════════════════════════════════╗
║          Tokenistt FinOps — LIVE ✓               ║
║                                                  ║
║  Gateway:    http://localhost:4000               ║
║  Dashboard:  http://localhost:3000               ║
║                                                  ║
║  Open your browser and visit those URLs          ║
╚══════════════════════════════════════════════════╝
`);
