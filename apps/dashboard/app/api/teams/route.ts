import { NextRequest, NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';
import { getSessionFromRequest, unauthorizedResponse, forbiddenResponse } from '@/lib/auth';
import { can } from '@/lib/rbac';
import { dbUnavailable } from '@/lib/db-unavailable';

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const dbUp = await isDbAvailable();
  if (!dbUp) return dbUnavailable();

  try {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name            text NOT NULL,
        slug            text NOT NULL,
        cost_center     text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, slug)
      );
    `);

    const { rows } = await pool.query(
      `SELECT 
        tm.id::text,
        tm.public_id::text,
        tm.name,
        tm.slug,
        tm.cost_center,
        tm.created_at,
        COALESCE((
          SELECT COUNT(*)::int FROM projects p WHERE p.team_id = tm.id
        ), 0) AS active_projects,
        COALESCE((
          SELECT SUM(t.cost_usd)::float FROM transactions t WHERE t.team_id = tm.id
        ), 0.0) AS total_spend
       FROM teams tm
       WHERE tm.organization_id = $1
       ORDER BY tm.name ASC`,
      [session.orgId]
    );

    return NextResponse.json({ teams: rows });
  } catch (err: any) {
    console.error('[Teams API GET Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();
  if (!can(session.role, 'users:write')) return forbiddenResponse();

  try {
    const body = await req.json();
    const { name, cost_center } = body;

    if (!name) {
      return NextResponse.json({ error: { message: 'Team name is required' } }, { status: 400 });
    }

    const slug = body.slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 32);

    const dbUp = await isDbAvailable();
    if (!dbUp) {
      return NextResponse.json({
        success: true,
        team: { id: Date.now().toString(), name, slug, cost_center: cost_center || 'default' },
      });
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO teams (organization_id, name, slug, cost_center)
       VALUES ($1, $2, $3, $4)
       RETURNING id::text, public_id::text, name, slug, cost_center`,
      [session.orgId, name, slug, cost_center || null]
    );

    return NextResponse.json({ success: true, team: rows[0] });
  } catch (err: any) {
    console.error('[Teams API POST Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

