/**
 * lib/rbac.ts — Role-Based Access Control matrix for Tokenistt.
 */

export type Role = 'owner' | 'admin' | 'finance' | 'developer' | 'viewer';

export type Permission =
  | 'spend:read'
  | 'budget:write'
  | 'keys:write'
  | 'users:write'
  | 'billing:write'
  | 'policies:write'
  | 'reports:export';

export const PERMISSIONS: Record<Permission, Role[]> = {
  'spend:read':     ['owner', 'admin', 'finance', 'developer', 'viewer'],
  'budget:write':   ['owner', 'admin', 'finance'],
  'keys:write':     ['owner', 'admin', 'developer'],
  'users:write':    ['owner', 'admin'],
  'billing:write':  ['owner', 'finance'],
  'policies:write': ['owner', 'admin', 'developer'],
  'reports:export': ['owner', 'admin', 'finance'],
};

export function can(role: Role, permission: Permission): boolean {
  const allowedRoles = PERMISSIONS[permission];
  return allowedRoles ? allowedRoles.includes(role) : false;
}

