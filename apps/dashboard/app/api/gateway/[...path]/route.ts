/**
 * Server-side proxy from the dashboard to the gateway management API (/v1/admin/*).
 *
 * The browser never sees gateway credentials. The session is verified here first, then
 * the request is forwarded with the user's own JWT (the gateway enforces role + org from
 * it). Without a token (local dev session) an ADMIN_SECRET configured on the dashboard
 * server is used instead, scoped to the session's organization.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest, unauthorizedResponse } from '@/lib/auth';

const GATEWAY = (process.env.GATEWAY_URL || process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:3000').replace(/\/+$/, '');

const ALLOWED_ROOTS = new Set([
  'budgets', 'policies', 'routing-rules', 'alerts', 'audit', 'approvals', 'workspaces', 'teams',
  'projects', 'provider-keys', 'keys', 'connectors', 'attribution', 'requests', 'reports',
]);
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const { path } = await ctx.params;
  if (!path?.length || !ALLOWED_ROOTS.has(path[0]) || !path.every(s => SEGMENT.test(s) && s !== '..')) {
    return NextResponse.json({ error: { message: 'Not found' } }, { status: 404 });
  }

  const headers: Record<string, string> = { Accept: req.headers.get('accept') ?? 'application/json' };
  const token =
    req.cookies.get('tokenistt_session')?.value ??
    (req.headers.get('authorization')?.startsWith('Bearer ') ? req.headers.get('authorization')!.slice(7) : undefined);

  const url = new URL(`${GATEWAY}/v1/admin/${path.join('/')}`);
  req.nextUrl.searchParams.forEach((v, k) => {
    if (k !== 'organization_id') url.searchParams.set(k, v); // org is never client-controlled
  });

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (process.env.ADMIN_SECRET) {
    headers['X-Admin-Secret'] = process.env.ADMIN_SECRET;
    url.searchParams.set('organization_id', /^\d+$/.test(session.orgId) ? session.orgId : '1');
  } else {
    return NextResponse.json({ error: { message: 'No gateway credentials: sign in, or set ADMIN_SECRET on the dashboard server.' } }, { status: 401 });
  }

  let body: string | undefined;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    body = await req.text();
    headers['Content-Type'] = 'application/json';
  }

  try {
    const upstream = await fetch(url, { method: req.method, headers, body, cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    const out = new NextResponse(await upstream.arrayBuffer(), { status: upstream.status });
    for (const h of ['content-type', 'content-disposition']) {
      const v = upstream.headers.get(h);
      if (v) out.headers.set(h, v);
    }
    return out;
  } catch {
    return NextResponse.json({ error: { message: `Gateway unreachable at ${GATEWAY}.` } }, { status: 502 });
  }
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
