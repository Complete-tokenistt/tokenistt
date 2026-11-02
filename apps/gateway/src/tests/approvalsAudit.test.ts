import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { checkPolicies } from '../db/policies.js';
import { decideApproval, listApprovals } from '../services/approvals.js';
import { logDecision, logAdminAction } from '../services/auditLogger.js';
import type { AuthContext } from '../db/auth.js';

const hasDb = !!process.env.DATABASE_URL;
const suffix = randomUUID().slice(0, 8);
let orgId: bigint;
let auth: AuthContext;

const chat = (content: string) => ({
  model: 'gpt-4o',
  messages: [{ role: 'user' as const, content }],
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('approval workflow + immutable audit log', { skip: !hasDb && 'DATABASE_URL not set' }, () => {
  before(async () => {
    const pool = getPool();
    const org = await pool.query(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Approvals ${suffix}`, `approvals-${suffix}`]
    );
    orgId = BigInt(org.rows[0].id);
    await pool.query(
      `INSERT INTO policies (organization_id, name, conditions, actions)
       VALUES ($1, 'needs approval', $2, $3)`,
      [orgId.toString(), JSON.stringify({ prompt_keyword: 'deploy-prod' }),
       JSON.stringify({ effect: 'require_approval', message: 'Prod deploys need sign-off' })]
    );
    auth = {
      virtualKeyId: 1n, virtualKeyPublicId: `vk-${suffix}`, workspaceId: null, organizationId: orgId,
      costCenter: 'CC-Test', actor: 'dev@example.com', budgetCapUsd: null, budgetUsedUsd: 0,
      budgetPeriod: 'monthly', allowedProviders: [], realApiKey: null,
    };
  });

  after(async () => {
    // audit tables are append-only by design; cascade-free cleanup of the rest only
    const pool = getPool();
    await pool.query('DELETE FROM approval_requests WHERE organization_id = $1', [orgId.toString()]);
    await pool.query('DELETE FROM policies WHERE organization_id = $1', [orgId.toString()]);
  });

  it('unrelated requests pass untouched', async () => {
    const r = await checkPolicies(auth, chat('hello'), 'req-1');
    assert.equal(r.allowed, true);
  });

  it('matching request creates a pending approval and is blocked with approval_required', async () => {
    const r = await checkPolicies(auth, chat('please deploy-prod now'), 'req-2');
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'approval_required');
    assert.ok(r.approvalId);

    // same request again does not create a duplicate
    const again = await checkPolicies(auth, chat('please deploy-prod now'), 'req-3');
    assert.equal(again.approvalId, r.approvalId);
    const pending = await listApprovals(orgId.toString(), 'pending');
    assert.equal(pending.length, 1);
  });

  it('after approval the identical request passes; a different request still needs approval', async () => {
    const [pending] = await listApprovals(orgId.toString(), 'pending');
    const decided = await decideApproval(pending.public_id, 'approved', 'admin@example.com');
    assert.equal(decided?.status, 'approved');

    const ok = await checkPolicies(auth, chat('please deploy-prod now'), 'req-4');
    assert.equal(ok.allowed, true);

    const other = await checkPolicies(auth, chat('deploy-prod service B'), 'req-5');
    assert.equal(other.code, 'approval_required');
  });

  it('a decided approval cannot be re-decided', async () => {
    const [approved] = await listApprovals(orgId.toString(), 'approved');
    assert.equal(await decideApproval(approved.public_id, 'denied', 'attacker'), null);
  });

  it('denied approvals block with approval_denied', async () => {
    const [pending] = await listApprovals(orgId.toString(), 'pending');
    await decideApproval(pending.public_id, 'denied', 'admin@example.com');
    const r = await checkPolicies(auth, chat('deploy-prod service B'), 'req-6');
    assert.equal(r.allowed, false);
    assert.equal(r.code, 'approval_denied');
  });

  it('decisions are written to policy_audit_log and cannot be updated or deleted', async () => {
    logDecision({ organizationId: orgId, kind: 'routing', requestId: 'req-x', decision: 'route', metadata: { apiKey: 'sk-secret' } });
    logAdminAction({ organizationId: orgId, actor: 'admin@example.com', action: 'budget.update', after: { password: 'hunter2', cap: 5 } });

    // fire-and-forget writes: poll rather than sleep a fixed time, which is too short on a loaded CI runner
    const pool = getPool();
    const fetchRows = () => pool.query(
      `SELECT id, metadata FROM policy_audit_log WHERE organization_id = $1 ORDER BY id`, [orgId.toString()]
    );
    let rows = await fetchRows();
    const adminRows = () => pool.query(`SELECT after FROM audit_log WHERE organization_id = $1`, [orgId.toString()]);
    for (let i = 0; i < 50 && (rows.rows.length < 3 || (await adminRows()).rows.length < 1); i++) {
      await wait(100);
      rows = await fetchRows();
    }
    assert.ok(rows.rows.length >= 3, 'policy decisions recorded');
    const routed = rows.rows.find(r => r.metadata.apiKey !== undefined);
    assert.equal(routed.metadata.apiKey, '[REDACTED]');

    const adm = await pool.query(`SELECT after FROM audit_log WHERE organization_id = $1`, [orgId.toString()]);
    assert.equal(adm.rows[0].after.password, '[REDACTED]');
    assert.equal(adm.rows[0].after.cap, 5);

    await assert.rejects(pool.query(`UPDATE policy_audit_log SET decision = 'x' WHERE id = $1`, [rows.rows[0].id]), /append-only/);
    await assert.rejects(pool.query(`DELETE FROM audit_log WHERE organization_id = $1`, [orgId.toString()]), /append-only/);
  });
});
