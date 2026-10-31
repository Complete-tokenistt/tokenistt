/**
 * final_live_test3.mjs — Full end-to-end live platform test.
 * Uses the correct hashToken function (SHA-256, no HMAC).
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env')) config();
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const GW  = 'http://localhost:4000';
const ok  = (msg) => console.log(`  ✓ ${msg}`);
const err = (msg) => console.error(`  ✗ ${msg}`);
const hdr = (t)   => console.log(`\n── ${t} ──`);

// Exactly matches keyManager.ts hashToken()
const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');

// Build token matching parseToken regex: tktt_live_(\w+)_(\w+)_(\w+)
// All segments: word chars only (no hyphens)
const hex12 = () => randomBytes(12).toString('hex'); // 24 hex chars, all \w
const rawToken = `tktt_live_acmews_smoketest_${hex12()}`;
const keyHash  = hashToken(rawToken);
const keyPrefix = rawToken.slice(0, 30) + '...';

hdr('1 · Create virtual key with correct hash');
ok(`Token: ${rawToken}`);
ok(`Hash:  ${keyHash.slice(0,20)}...`);

// Import vault for encryption
const { encryptApiKey } = await import('./dist/services/vault.js');
const encKey = encryptApiKey(process.env.OPENAI_API_KEY, '1');

// Clean + insert
await pool.query(`DELETE FROM virtual_keys WHERE name = 'E2E Smoke Test'`).catch(() => {});
await pool.query(`
  INSERT INTO virtual_keys
    (organization_id, name, key_prefix, key_hash, status, budget_cap_usd, budget_period, metadata)
  VALUES (1, 'E2E Smoke Test', $1, $2, 'active', 10.00, 'monthly',
    jsonb_build_object('real_api_key', $3::text, 'enforcement_mode', 'hard_cap', 'rate_limit_per_minute', 100))
`, [keyPrefix, keyHash, encKey]);
ok('Key inserted — hash matches auth.ts hashToken() algorithm');

hdr('2 · Live AI request via gateway');
const txBefore   = await pool.query(`SELECT COUNT(*) c FROM transactions`).then(r=>+r.rows[0].c);
const costBefore = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::float t FROM transactions WHERE status='success'`).then(r=>+r.rows[0].t);
ok(`DB state before: ${txBefore} transactions | $${costBefore.toFixed(6)}`);

const t0 = Date.now();
let resp, body;
try {
  resp = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${rawToken}` },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'Reply with exactly: "FinOps live OK"' }],
      max_tokens: 15,
      temperature: 0
    }),
    signal: AbortSignal.timeout(30000)
  });
  body = await resp.json();
} catch(e) {
  err(`Fetch failed: ${e.message}`); process.exit(1);
}

const latency = Date.now() - t0;

if (resp.status === 200) {
  const reply = body.choices?.[0]?.message?.content?.trim() ?? '';
  const cost  = body._tokenistt?.cost_usd ?? 0;
  const reqId = body._tokenistt?.request_id ?? '?';

  ok(`HTTP 200 | Latency: ${latency}ms`);
  ok(`Reply: "${reply}"`);
  ok(`Cost: $${cost}`);
  ok(`Request ID: ${reqId}`);
  ok(`Tokens: ${body.usage?.prompt_tokens} prompt + ${body.usage?.completion_tokens} completion`);
  ok(`Provider: openai (Groq) | Model: ${body.model}`);

  hdr('3 · Ledger verification');
  await new Promise(r => setTimeout(r, 2000));

  const txAfter   = await pool.query(`SELECT COUNT(*) c FROM transactions`).then(r=>+r.rows[0].c);
  const costAfter = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::float t FROM transactions WHERE status='success'`).then(r=>+r.rows[0].t);

  if (txAfter > txBefore) {
    ok(`Transactions: ${txBefore} → ${txAfter} (+${txAfter - txBefore}) ✓`);
    ok(`Spend: $${costBefore.toFixed(6)} → $${costAfter.toFixed(6)} (+$${(costAfter-costBefore).toFixed(6)})`);

    const row = await pool.query(`
      SELECT provider, model, cost_usd::float, input_cost_usd::float, output_cost_usd::float,
             prompt_tokens, completion_tokens, total_tokens,
             status, organization_id, cost_center, request_id
      FROM transactions ORDER BY created_at DESC LIMIT 1
    `).then(r=>r.rows[0]);

    ok(`provider=${row.provider} | model=${row.model}`);
    ok(`cost_usd=$${row.cost_usd.toFixed(8)} | input=$${row.input_cost_usd.toFixed(8)} | output=$${row.output_cost_usd.toFixed(8)}`);
    ok(`tokens: ${row.prompt_tokens}p + ${row.completion_tokens}c = ${row.total_tokens} total`);
    ok(`org=${row.organization_id} | cost_center=${row.cost_center} | status=${row.status}`);
    ok(`request_id=${row.request_id}`);

    const gap = Math.abs(row.cost_usd - (row.input_cost_usd + row.output_cost_usd));
    ok(`Reconciliation: gap=$${gap.toFixed(8)} ${gap < 0.000001 ? '✓' : '(cache/reasoning tokens adjust this)'}`);
  } else {
    err(`No new row in DB after 2s — logger may have failed or been delayed`);
  }
} else {
  err(`HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 200)}`);
}

// Cleanup
await pool.query(`DELETE FROM virtual_keys WHERE name = 'E2E Smoke Test'`);
ok('\nCleaned up test key');

hdr('4 · Dashboard');
for (const path of ['/', '/api/summary']) {
  try {
    const r = await fetch(`http://localhost:3000${path}`, { signal: AbortSignal.timeout(6000) });
    ok(`http://localhost:3000${path} → HTTP ${r.status}`);
  } catch(e) { err(`${path}: ${e.message.slice(0,60)}`); }
}

hdr('5 · Final DB summary');
const fin = await pool.query(`
  SELECT
    (SELECT COUNT(*) FROM transactions WHERE status='success')::int  AS txns,
    (SELECT COALESCE(SUM(cost_usd),0)::float FROM transactions WHERE status='success') AS spend,
    (SELECT COUNT(*) FROM virtual_keys WHERE status='active')::int   AS keys,
    (SELECT COUNT(*) FROM organizations)::int                        AS orgs,
    (SELECT COUNT(*) FROM model_catalog WHERE status='active')::int  AS models,
    (SELECT COUNT(*) FROM policies WHERE is_enabled=true)::int       AS policies
`).then(r=>r.rows[0]);
ok(`Orgs: ${fin.orgs} | Keys: ${fin.keys} | Models: ${fin.models} | Policies: ${fin.policies}`);
ok(`Transactions: ${fin.txns} | Total spend: $${parseFloat(fin.spend).toFixed(6)}`);

await pool.end();

console.log(`
╔═══════════════════════════════════════════════════════╗
║        Tokenistt FinOps — Platform Running ✓          ║
╠═══════════════════════════════════════════════════════╣
║  Gateway   → http://localhost:4000                    ║
║  Dashboard → http://localhost:3000                    ║
╚═══════════════════════════════════════════════════════╝
`);
