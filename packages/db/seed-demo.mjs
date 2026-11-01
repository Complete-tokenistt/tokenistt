#!/usr/bin/env node
/**
 * Seeds a clearly-fake demo organization so a fresh install has something to look at.
 *
 *   DATABASE_URL=postgres://… node packages/db/seed-demo.mjs
 *
 * Re-running replaces the previous demo org. All figures are synthetic and generated
 * locally — nothing here describes real usage. Never run against a production database.
 */
import { randomBytes, createHash, scryptSync } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
if (/prod/i.test(url) || process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data into something that looks like production.'); process.exit(1);
}

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo-password-123';
const pool = new pg.Pool({ connectionString: url });
const q = (text, params) => pool.query(text, params);
const pick = a => a[Math.floor(Math.random() * a.length)];
const hashPassword = pw => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`; };

// Illustrative per-1M-token prices used only to make the demo numbers plausible.
const MODELS = [
  ['openai', 'gpt-4o', 2.5, 10], ['openai', 'gpt-4o-mini', 0.15, 0.6],
  ['anthropic', 'claude-3-5-sonnet', 3, 15], ['anthropic', 'claude-3-haiku', 0.25, 1.25],
  ['groq', 'llama-3.3-70b', 0.59, 0.79],
];
const FEATURES = ['search', 'support-bot', 'summaries', 'code-review', 'onboarding'];
const REPOS = ['demo-co/api', 'demo-co/web', 'demo-co/ml-pipeline'];
const CUSTOMERS = ['acme', 'globex', 'initech', 'hooli', 'umbrella'];

async function main() {
  // SEED_ORG_ID: add the demo data to an existing org (the no-login "Local workspace") instead of a new one.
  // Run it once — it does not de-duplicate against a previous run on the same org.
  const into = process.env.SEED_ORG_ID;
  let org;
  if (into) {
    org = (await q(`SELECT id::text FROM organizations WHERE id = $1`, [into])).rows[0]?.id;
    if (!org) throw new Error(`organization ${into} does not exist`);
  } else {
    await q(`DELETE FROM organizations WHERE slug = 'demo-co'`);
    org = (await q(`INSERT INTO organizations (name, slug, plan) VALUES ('Demo Co (synthetic data)', 'demo-co', 'team') RETURNING id::text`)).rows[0].id;
    for (const [email, role] of [['owner@demo.test', 'owner'], ['finance@demo.test', 'finance'], ['viewer@demo.test', 'viewer']]) {
      await q(`INSERT INTO users (organization_id, email, display_name, password_hash, role) VALUES ($1,$2,$3,$4,$5)`,
        [org, email, email.split('@')[0], hashPassword(DEMO_PASSWORD), role]);
    }
  }

  const wsSupport = (await q(`INSERT INTO workspaces (organization_id, name, cost_center, budget_cap_usd) VALUES ($1,'Support','CC-4401-Support',500) RETURNING id::text`, [org])).rows[0].id;
  const wsEng = (await q(`INSERT INTO workspaces (organization_id, name, cost_center, budget_cap_usd) VALUES ($1,'Engineering','CC-1001-Eng',1500) RETURNING id::text`, [org])).rows[0].id;
  const teamSupport = (await q(`INSERT INTO teams (organization_id, name, slug, cost_center) VALUES ($1,'Support','support','CC-4401-Support') RETURNING id::text`, [org])).rows[0].id;
  const teamPlatform = (await q(`INSERT INTO teams (organization_id, name, slug, cost_center) VALUES ($1,'Platform','platform','CC-1001-Eng') RETURNING id::text`, [org])).rows[0].id;
  const projBot = (await q(`INSERT INTO projects (organization_id, team_id, name, slug) VALUES ($1,$2,'Support bot','support-bot') RETURNING id::text`, [org, teamSupport])).rows[0].id;
  const projCopilot = (await q(`INSERT INTO projects (organization_id, team_id, name, slug) VALUES ($1,$2,'Copilot','copilot') RETURNING id::text`, [org, teamPlatform])).rows[0].id;

  // Virtual keys — the raw tokens are printed once at the end.
  const tokens = {};
  const keyIds = {};
  for (const [name, ws, cap] of [['demo-key', wsEng, 200], ['support-bot-key', wsSupport, 100]]) {
    const raw = `tktt_live_demo_${name.replace(/[^a-z0-9]/g, '')}_${randomBytes(24).toString('hex')}`;
    const hash = createHash('sha256').update(raw).digest('hex');
    keyIds[name] = (await q(
      `INSERT INTO virtual_keys (organization_id, workspace_id, name, key_prefix, key_hash, budget_cap_usd, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'{"rate_limit_per_minute":100,"enforcement_mode":"hard_cap"}') RETURNING id::text`,
      [org, ws, name, `${raw.slice(0, 20)}...`, hash, cap])).rows[0].id;
    tokens[name] = raw;
  }

  // Governance
  await q(`INSERT INTO policies (organization_id, name, description, conditions, actions) VALUES
    ($1,'Block GPT-4 for interns','High-cost model is off-limits for the interns cost center','{"cost_center":"interns","model":"gpt-4"}','{"effect":"block","message":"GPT-4 is not available to interns."}'),
    ($1,'Production deploys need sign-off','Prompts that mention deploy-prod are held for approval','{"prompt_keyword":"deploy-prod"}','{"effect":"require_approval","message":"Production deploys need sign-off."}')`, [org]);
  await q(`INSERT INTO routing_rules (organization_id, name, priority, strategy, match, targets) VALUES
    ($1,'Cheapest for summaries',10,'cheapest','{"model":"summar"}','[{"provider":"openai","model":"gpt-4o-mini"},{"provider":"groq","model":"llama-3.3-70b"},{"provider":"anthropic","model":"claude-3-haiku"}]')`, [org]);
  await q(`INSERT INTO budgets (organization_id, scope_type, scope_id, name, cap_usd, enforcement_mode) VALUES
    ($1,'organization',$1,'Company-wide AI spend',2000,'alert_only'),
    ($1,'team',$2,'Support team',300,'hard_cap')`, [org, teamSupport]);

  // Synthetic traffic: 14 days.
  let total = 0;
  for (let d = 13; d >= 0; d--) {
    const perDay = 12 + Math.floor(Math.random() * 18);
    for (let i = 0; i < perDay; i++) {
      const [provider, model, pin, pout] = pick(MODELS);
      const inTok = 200 + Math.floor(Math.random() * 3000);
      const outTok = 50 + Math.floor(Math.random() * 900);
      const cost = (inTok * pin + outTok * pout) / 1_000_000;
      const roll = Math.random();
      const status = roll < 0.92 ? 'success' : roll < 0.97 ? 'error' : 'rate_limited';
      const support = Math.random() < 0.4;
      total += status === 'success' ? cost : 0;
      await q(
        `INSERT INTO transactions (organization_id, workspace_id, virtual_key_id, team_id, project_id, actor, provider, model, cost_center,
            cost_usd, input_cost_usd, output_cost_usd, prompt_tokens, completion_tokens, total_tokens, status, error_code, duration_ms,
            feature, repo, customer, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now() - ($22 || ' days')::interval - ($23 || ' minutes')::interval)`,
        [org, support ? wsSupport : wsEng, support ? keyIds['support-bot-key'] : keyIds['demo-key'], support ? teamSupport : teamPlatform,
         support ? projBot : projCopilot, pick(['sarah@demo.test', 'dev@demo.test', 'ci-bot']), provider, model,
         support ? 'CC-4401-Support' : 'CC-1001-Eng',
         status === 'success' ? cost.toFixed(6) : '0', (inTok * pin / 1e6).toFixed(6), (outTok * pout / 1e6).toFixed(6),
         inTok, outTok, inTok + outTok, status, status === 'success' ? null : status === 'error' ? 'provider_error' : 'rate_limited',
         300 + Math.floor(Math.random() * 2500), pick(FEATURES), pick(REPOS), pick(CUSTOMERS), String(d), String(Math.floor(Math.random() * 1200))]);
    }
  }

  await q(`INSERT INTO budget_alerts (organization_id, severity, title, message, channels) VALUES
    ($1,'warn','Budget warn: team budget at 84.2%','Support team has used $252.60 of $300.00 this month.','["webhook"]'),
    ($1,'critical','Budget critical: project budget at 93.0%','Copilot is close to its monthly cap.','["webhook","email"]')`, [org]);
  await q(`INSERT INTO approval_requests (organization_id, request_fingerprint, requester, model, reason) VALUES ($1,$2,'dev@demo.test','gpt-4o','Production deploys need sign-off.')`,
    [org, createHash('sha256').update('demo').digest('hex')]);
  await q(`INSERT INTO audit_log (organization_id, actor, action, entity_type, entity_id, after) VALUES
    ($1,'owner@demo.test','budget.create','budget','demo','{"cap_usd":300}'),
    ($1,'owner@demo.test','policy.create','policy','demo','{"name":"Production deploys need sign-off"}')`, [org]);
  await q(`INSERT INTO policy_audit_log (organization_id, kind, decision, reason, metadata) VALUES
    ($1,'policy','require_approval','Production deploys need sign-off.','{"policy":"Production deploys need sign-off"}'),
    ($1,'routing','route','cheapest: openai:gpt-4o-mini > groq:llama-3.3-70b','{"rule":"Cheapest for summaries"}')`, [org]);

  console.log('\nDemo organization ready (synthetic data).');
  console.log(`  Organization id : ${org}`);
  console.log(`  Total demo spend: $${total.toFixed(2)} over 14 days`);
  console.log('\n  Dashboard logins (password for all: %s)', DEMO_PASSWORD);
  console.log('    owner@demo.test    owner   — everything');
  console.log('    finance@demo.test  finance — budgets, approvals, reports, audit');
  console.log('    viewer@demo.test   viewer  — read-only');
  console.log('\n  API keys (shown once):');
  for (const [n, t] of Object.entries(tokens)) console.log(`    ${n}: ${t}`);
}

try { await main(); } finally { await pool.end(); }
