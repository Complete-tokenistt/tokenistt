import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { enforceBudgets } from '../services/budgetEngine.js';
import { resolveAttribution, clearResolverCache } from '../services/workspaceResolver.js';
import type { AuthContext } from '../db/auth.js';

const hasDb = !!process.env.DATABASE_URL;
const sfx = randomUUID().slice(0, 8);
let orgId: bigint;
let teamA: bigint;
let teamB: bigint;
let vkId: bigint;

const mkAuth = (teamId: bigint | null): AuthContext => ({
  virtualKeyId: vkId, virtualKeyPublicId: `vk-${sfx}`, workspaceId: null, organizationId: orgId,
  costCenter: 'CC-Budget', actor: 'dev', budgetCapUsd: null, budgetUsedUsd: 0, budgetPeriod: 'monthly',
  allowedProviders: [], realApiKey: null,
  attribution: { teamId, projectId: null, environment: null, repo: null, ticket: null, sprint: null,
                 feature: null, customer: null, employee: null },
});

describe('hierarchical budgets are scoped, not org-wide', { skip: !hasDb && 'DATABASE_URL not set' }, () => {
  before(async () => {
    const pool = getPool();
    orgId = BigInt((await pool.query(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id`, [`Budgets ${sfx}`, `budgets-${sfx}`])).rows[0].id);
    teamA = BigInt((await pool.query(`INSERT INTO teams (organization_id, name, slug) VALUES ($1,'A',$2) RETURNING id`, [orgId.toString(), `a-${sfx}`])).rows[0].id);
    teamB = BigInt((await pool.query(`INSERT INTO teams (organization_id, name, slug) VALUES ($1,'B',$2) RETURNING id`, [orgId.toString(), `b-${sfx}`])).rows[0].id);
    vkId = BigInt((await pool.query(
      `INSERT INTO virtual_keys (organization_id, name, key_prefix, key_hash) VALUES ($1,'k','tk_x','h') RETURNING id`, [orgId.toString()])).rows[0].id);

    // Team A has a $10 hard cap and has already spent $12; team B has a $10 cap and spent $1.
    for (const [team, cost] of [[teamA, '12'], [teamB, '1']] as const) {
      await pool.query(
        `INSERT INTO budgets (organization_id, scope_type, scope_id, cap_usd, period, enforcement_mode)
         VALUES ($1,'team',$2,10,'monthly','hard_cap')`, [orgId.toString(), team.toString()]);
      await pool.query(
        `INSERT INTO transactions (organization_id, virtual_key_id, team_id, provider, model, cost_center, cost_usd)
         VALUES ($1,$2,$3,'openai','gpt-4o','CC-Budget',$4)`, [orgId.toString(), vkId.toString(), team.toString(), cost]);
    }
  });

  after(async () => {
    const pool = getPool();
    await pool.query('DELETE FROM budget_alerts WHERE organization_id = $1', [orgId.toString()]);
    await pool.query('DELETE FROM budgets WHERE organization_id = $1', [orgId.toString()]);
    await pool.query('DELETE FROM transactions WHERE organization_id = $1', [orgId.toString()]);
    await pool.query('DELETE FROM virtual_keys WHERE organization_id = $1', [orgId.toString()]);
    await pool.query('DELETE FROM teams WHERE organization_id = $1', [orgId.toString()]);
  });

  it('blocks the over-budget team', async () => {
    const r = await enforceBudgets(mkAuth(teamA), 'req-a');
    assert.equal(r.allowed, false);
    assert.equal(r.result?.scopeType, 'team');
    assert.equal(r.result?.level, 'exceeded');
  });

  it('does not block another team that is under its own cap', async () => {
    const r = await enforceBudgets(mkAuth(teamB), 'req-b');
    assert.equal(r.allowed, true);
  });

  it('requests with no team are not subject to team budgets', async () => {
    const r = await enforceBudgets(mkAuth(null), 'req-c');
    assert.equal(r.allowed, true);
  });

  it('alert_only budgets never block and throttle mode returns a delay', async () => {
    const pool = getPool();
    await pool.query(`UPDATE budgets SET enforcement_mode = 'alert_only' WHERE organization_id = $1`, [orgId.toString()]);
    assert.equal((await enforceBudgets(mkAuth(teamA))).allowed, true);

    await pool.query(`UPDATE budgets SET enforcement_mode = 'auto_throttle', cap_usd = 1.05 WHERE scope_id = $1 AND organization_id = $2`, [teamB.toString(), orgId.toString()]);
    const r = await enforceBudgets(mkAuth(teamB));
    assert.equal(r.allowed, true);
    assert.ok(r.throttleMs > 0);
  });

  it('resolves team slug and attribution headers', async () => {
    clearResolverCache();
    const attr = await resolveAttribution(mkAuth(null), {
      'x-tokenistt-team': `a-${sfx}`, 'x-tokenistt-project': 'nope',
      'x-tokenistt-feature': 'search', 'x-tokenistt-customer': 'acme', 'x-tokenistt-repo': 'org/api',
    });
    assert.equal(attr.teamId, teamA);
    assert.equal(attr.projectId, null);
    assert.deepEqual([attr.feature, attr.customer, attr.repo], ['search', 'acme', 'org/api']);
  });
});
