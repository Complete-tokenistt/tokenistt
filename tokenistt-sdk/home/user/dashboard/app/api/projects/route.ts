import { NextRequest, NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';
import { getSessionFromRequest, unauthorizedResponse, forbiddenResponse } from '@/lib/auth';
import { can } from '@/lib/rbac';

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const dbUp = await isDbAvailable();
  if (!dbUp) {
    return NextResponse.json({
      projects: [
        { id: '1', name: 'Copilot Assistant', slug: 'copilot-assistant', team_name: 'Core Engineering', environment: 'production', total_spend: 12400.50, request_count: 85200 },
        { id: '2', name: 'RAG Knowledge Search', slug: 'rag-search', team_name: 'Core Engineering', environment: 'production', total_spend: 6050.00, request_count: 41000 },
        { id: '3', name: 'Support Zendesk Bot', slug: 'support-bot', team_name: 'Customer Support', environment: 'production', total_spend: 6320.10, request_count: 94000 },
      ],
    });
  }

  try {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        team_id         bigint REFERENCES teams(id) ON DELETE SET NULL,
        name            text NOT NULL,
        slug            text NOT NULL,
        environment     text NOT NULL DEFAULT 'production',
        created_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, slug)
      );
    `);

    const { rows } = await pool.query(
      `SELECT 
        p.id::text,
        p.public_id::text,
        p.name,
        p.slug,
        p.environment,
        p.created_at,
        COALESCE(tm.name, 'Unassigned') AS team_name,
        COALESCE((
          SELECT SUM(t.cost_usd)::float FROM transactions t WHERE t.project_id = p.id
        ), 0.0) AS total_spend,
        COALESCE((
          SELECT COUNT(*)::int FROM transactions t WHERE t.project_id = p.id
        ), 0) AS request_count
       FROM projects p
       LEFT JOIN teams tm ON tm.id = p.team_id
       WHERE p.organization_id = $1
       ORDER BY p.name ASC`,
      [session.orgId]
    );

    return NextResponse.json({ projects: rows });
  } catch (err: any) {
    console.error('[Projects API GET Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();
  if (!can(session.role, 'users:write')) return forbiddenResponse();

  try {
    const body = await req.json();
    const { name, team_id, environment = 'production' } = body;

    if (!name) {
      return NextResponse.json({ error: { message: 'Project name is required' } }, { status: 400 });
    }

    const slug = body.slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 32);

    const dbUp = await isDbAvailable();
    if (!dbUp) {
      return NextResponse.json({
        success: true,
        project: { id: Date.now().toString(), name, slug, environment },
      });
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO projects (organization_id, team_id, name, slug, environment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id::text, public_id::text, name, slug, environment`,
      [session.orgId, team_id ? String(team_id) : null, name, slug, environment]
    );

    return NextResponse.json({ success: true, project: rows[0] });
  } catch (err: any) {
    console.error('[Projects API POST Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

