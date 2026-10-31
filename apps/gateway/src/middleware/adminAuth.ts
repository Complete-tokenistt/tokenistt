/**
 * middleware/adminAuth.ts — authentication + RBAC for the management API.
 *
 * Two credentials are accepted:
 *   1. `X-Admin-Secret`      → operator access; may act on any organization
 *                              (organization chosen by ?organization_id= or X-Organization-Id).
 *   2. `Authorization: Bearer <dashboard JWT>` (HS256, signed with JWT_SECRET)
 *                            → user access, locked to the organization in the token and
 *                              limited to what the user's role permits.
 *
 * Role matrix mirrors apps/dashboard/lib/rbac.ts.
 */
import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPool } from '../db/pool.js';

export type Role = 'owner' | 'admin' | 'finance' | 'developer' | 'viewer';

export type Permission =
  | 'spend:read'
  | 'budget:write'
  | 'keys:write'
  | 'users:write'
  | 'billing:write'
  | 'policies:write'
  | 'routing:write'
  | 'approvals:decide'
  | 'connectors:write'
  | 'audit:read'
  | 'reports:export';

export const PERMISSIONS: Record<Permission, Role[]> = {
  'spend:read':       ['owner', 'admin', 'finance', 'developer', 'viewer'],
  'budget:write':     ['owner', 'admin', 'finance'],
  'keys:write':       ['owner', 'admin', 'developer'],
  'users:write':      ['owner', 'admin'],
  'billing:write':    ['owner', 'finance'],
  'policies:write':   ['owner', 'admin', 'developer'],
  'routing:write':    ['owner', 'admin', 'developer'],
  'approvals:decide': ['owner', 'admin', 'finance'],
  'connectors:write': ['owner', 'admin'],
  'audit:read':       ['owner', 'admin', 'finance'],
  'reports:export':   ['owner', 'admin', 'finance'],
};

export interface Principal {
  actor: string;
  role: Role;
  /** Internal organization id the principal is locked to; null for operator (secret) access. */
  organizationId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[permission]?.includes(role) ?? false;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface JwtClaims {
  sub: string;
  orgId: string;
  email?: string;
  role: Role;
  exp: number;
}

export function verifyDashboardJwt(token: string, secret: string): JwtClaims | null {
  try {
    const [h, p, sig] = token.split('.');
    if (!h || !p || !sig) return null;
    const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    const claims: JwtClaims = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8'));
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Dashboard tokens carry the org as its internal id or its public uuid; normalise to the internal id. */
async function resolveOrgId(orgRef: string): Promise<string | null> {
  if (/^\d+$/.test(orgRef)) return orgRef;
  try {
    const { rows } = await getPool().query<{ id: string }>(
      'SELECT id::text FROM organizations WHERE public_id::text = $1',
      [orgRef]
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

const deny = (res: Response, status: number, message: string) =>
  res.status(status).json({ error: { message, type: status === 403 ? 'permission_error' : 'authentication_error' } });

export async function adminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 1. Operator secret
  const secretHeader = req.headers['x-admin-secret'];
  if (typeof secretHeader === 'string') {
    const secret = process.env.ADMIN_SECRET || 'dev-admin-secret-change-in-production';
    if (safeEqual(secretHeader, secret)) {
      req.principal = { actor: 'operator', role: 'owner', organizationId: null };
      return next();
    }
    return void deny(res, 401, 'Invalid X-Admin-Secret.');
  }

  // 2. Dashboard JWT
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      return void deny(res, 401, 'Bearer tokens are disabled: JWT_SECRET is not configured on the gateway.');
    }
    const claims = verifyDashboardJwt(auth.slice(7).trim(), secret);
    if (!claims) return void deny(res, 401, 'Invalid or expired token.');
    const organizationId = await resolveOrgId(String(claims.orgId));
    if (!organizationId) return void deny(res, 401, 'Token organization not found.');
    req.principal = { actor: claims.email || claims.sub, role: claims.role, organizationId };
    return next();
  }

  deny(res, 401, 'Authentication required: send X-Admin-Secret or a Bearer token.');
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = req.principal;
    if (!p) return void deny(res, 401, 'Authentication required.');
    if (!can(p.role, permission)) return void deny(res, 403, `Role '${p.role}' lacks permission '${permission}'.`);
    next();
  };
}

/**
 * Organization a request operates on. User tokens are locked to their own org (a
 * conflicting ?organization_id= is rejected); operators must say which org.
 */
export function orgScope(req: Request): { ok: true; organizationId: string } | { ok: false; message: string } {
  const p = req.principal!;
  const requested = (req.query.organization_id ?? req.headers['x-organization-id'] ?? req.body?.organization_id)?.toString();
  if (p.organizationId) {
    if (requested && requested !== p.organizationId) return { ok: false, message: 'Cross-organization access is not allowed.' };
    return { ok: true, organizationId: p.organizationId };
  }
  if (!requested || !/^\d+$/.test(requested)) {
    return { ok: false, message: 'organization_id (numeric) is required for operator requests.' };
  }
  return { ok: true, organizationId: requested };
}
