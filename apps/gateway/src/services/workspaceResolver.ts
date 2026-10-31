/**
 * services/workspaceResolver.ts — resolves team / project and cost-attribution
 * dimensions for a request from `x-tokenistt-*` headers.
 *
 * Team and project are referenced by slug and looked up (60s in-process cache);
 * unknown slugs resolve to null rather than failing the request (fail-open).
 * Free-form dimensions (repo, ticket, sprint, feature, customer, employee) are
 * stored as-is on the transaction and later joined to connector entities.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { getPool } from '../db/pool.js';
import type { AuthContext } from '../db/auth.js';

export interface Attribution {
  teamId: bigint | null;
  projectId: bigint | null;
  environment: string | null;
  repo: string | null;
  ticket: string | null;
  sprint: string | null;
  feature: string | null;
  customer: string | null;
  employee: string | null;
}

export const EMPTY_ATTRIBUTION: Attribution = {
  teamId: null, projectId: null, environment: null,
  repo: null, ticket: null, sprint: null, feature: null, customer: null, employee: null,
};

const MAX_LEN = 200;
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { id: bigint | null; at: number }>();

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[`x-tokenistt-${name}`];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, MAX_LEN) : null;
}

async function lookupId(table: 'teams' | 'projects', orgId: bigint, slug: string): Promise<bigint | null> {
  const key = `${table}:${orgId}:${slug}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.id;

  try {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id::text FROM ${table} WHERE organization_id = $1 AND slug = $2`,
      [orgId.toString(), slug]
    );
    const id = rows[0] ? BigInt(rows[0].id) : null;
    cache.set(key, { id, at: Date.now() });
    return id;
  } catch {
    return null; // fail-open
  }
}

export function clearResolverCache(): void {
  cache.clear();
}

export async function resolveAttribution(
  auth: AuthContext,
  headers: IncomingHttpHeaders
): Promise<Attribution> {
  const teamSlug = header(headers, 'team');
  const projectSlug = header(headers, 'project');
  const dbReady = !!process.env.DATABASE_URL && auth.organizationId !== BigInt(0);

  const [teamId, projectId] = await Promise.all([
    dbReady && teamSlug ? lookupId('teams', auth.organizationId, teamSlug) : null,
    dbReady && projectSlug ? lookupId('projects', auth.organizationId, projectSlug) : null,
  ]);

  return {
    teamId,
    projectId,
    environment: header(headers, 'environment'),
    repo: header(headers, 'repo'),
    ticket: header(headers, 'ticket'),
    sprint: header(headers, 'sprint'),
    feature: header(headers, 'feature'),
    customer: header(headers, 'customer'),
    employee: header(headers, 'employee'),
  };
}
