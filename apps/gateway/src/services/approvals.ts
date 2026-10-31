/**
 * services/approvals.ts — approval workflow for the `require_approval` policy effect.
 *
 * Flow: a matching request creates a `pending` approval keyed by a fingerprint of
 * (org, key, model, messages). The gateway answers 403 `approval_required` with the
 * approval id and notifies Slack/email. An admin approves/denies through
 * /v1/admin/approvals/:id/{approve,deny}. The client retries the identical request:
 * once approved (and unexpired) it passes the policy check.
 */
import { createHash } from 'node:crypto';
import { getPool } from '../db/pool.js';
import type { AuthContext } from '../db/auth.js';
import type { OpenAIChatCompletionRequest } from '../types/index.js';
import { notifyAll } from './notify.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRow {
  public_id: string;
  organization_id: string;
  policy_id: string | null;
  requester: string | null;
  model: string | null;
  reason: string | null;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string;
  created_at: string;
}

export function requestFingerprint(auth: AuthContext, request: OpenAIChatCompletionRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        auth.organizationId.toString(),
        auth.virtualKeyId.toString(),
        request.model,
        request.messages,
      ])
    )
    .digest('hex');
}

const COLUMNS = `public_id::text, organization_id::text, policy_id::text, requester, model, reason,
  status, decided_by, decided_at, expires_at, created_at`;

/** Latest non-expired approval for this exact request, if any. */
export async function findApproval(orgId: bigint, fingerprint: string): Promise<ApprovalRow | null> {
  const { rows } = await getPool().query<ApprovalRow>(
    `SELECT ${COLUMNS} FROM approval_requests
      WHERE organization_id = $1 AND request_fingerprint = $2 AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [orgId.toString(), fingerprint]
  );
  return rows[0] ?? null;
}

export async function createApproval(args: {
  auth: AuthContext;
  policyId: string | null;
  fingerprint: string;
  model: string;
  reason: string;
}): Promise<ApprovalRow> {
  const { auth } = args;
  const { rows } = await getPool().query<ApprovalRow>(
    `INSERT INTO approval_requests (organization_id, policy_id, request_fingerprint, requester, model, reason)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
    [auth.organizationId.toString(), args.policyId, args.fingerprint, auth.actor, args.model, args.reason]
  );
  const row = rows[0];

  // Fire-and-forget: notification must never delay or fail the request.
  notifyAll({
    title: 'Approval required',
    text: `${auth.actor} (${auth.costCenter}) requested ${args.model}: ${args.reason}`,
    fields: { 'Approval ID': row.public_id, Model: args.model, 'Cost center': auth.costCenter },
    severity: 'warn',
  }).catch(() => {});
  return row;
}

export async function listApprovals(orgId: string | null, status?: ApprovalStatus): Promise<ApprovalRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (orgId) { params.push(orgId); where.push(`organization_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  const { rows } = await getPool().query<ApprovalRow>(
    `SELECT ${COLUMNS} FROM approval_requests
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT 200`,
    params
  );
  return rows;
}

/** Decide a pending approval. Returns null if it does not exist or is no longer pending. */
export async function decideApproval(
  publicId: string,
  decision: 'approved' | 'denied',
  decidedBy: string
): Promise<ApprovalRow | null> {
  const { rows } = await getPool().query<ApprovalRow>(
    `UPDATE approval_requests
        SET status = $2, decided_by = $3, decided_at = now()
      WHERE public_id = $1 AND status = 'pending' AND expires_at > now()
      RETURNING ${COLUMNS}`,
    [publicId, decision, decidedBy]
  );
  return rows[0] ?? null;
}
