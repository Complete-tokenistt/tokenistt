import { NextRequest, NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';
import { getSessionFromRequest, unauthorizedResponse, forbiddenResponse } from '@/lib/auth';
import { can } from '@/lib/rbac';

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const dbUp = await isDbAvailable();
  if (!dbUp) {
    // Return sample mock budget structure when DB is not configured
    return NextResponse.json({
      budgets: [
        {
          id: '1',
          name: 'Engineering Monthly Cap',
          scope_type: 'team',
          scope_id: '1',
          cap_usd: 10000.0,
          used_usd: 4230.5,
          percent_used: 42.3,
          period: 'monthly',
          warn_threshold_pct: 80,
          critical_threshold_pct: 90,
          enforcement_mode: 'hard_cap',
          is_active: true,
        },
        {
          id: '2',
          name: 'Customer Support Bot Cap',
          scope_type: 'project',
          scope_id: '1',
          cap_usd: 5000.0,
          used_usd: 4120.0,
          percent_used: 82.4,
          period: 'monthly',
          warn_threshold_pct: 80,
          critical_threshold_pct: 90,
          enforcement_mode: 'auto_throttle',
          is_active: true,
        },
      ],
    });
  }

  try {
    const pool = getPool();
    // Ensure budgets table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS budgets (
        id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        public_id            uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        organization_id      bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        scope_type           text NOT NULL CHECK (scope_type IN ('organization','team','project','virtual_key')),
        scope_id             bigint NOT NULL,
        name                 text,
        cap_usd              numeric(18,2) NOT NULL,
        period               text NOT NULL DEFAULT 'monthly',
        warn_threshold_pct   numeric(5,2) NOT NULL DEFAULT 80.0,
        critical_threshold_pct numeric(5,2) NOT NULL DEFAULT 90.0,
        enforcement_mode     text NOT NULL DEFAULT 'hard_cap',
        is_active            boolean NOT NULL DEFAULT true,
        created_at           timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { rows } = await pool.query(
      `SELECT 
        b.id::text,
        b.public_id::text,
        b.scope_type,
        b.scope_id::text,
        b.name,
        b.cap_usd::float,
        b.period,
        b.warn_threshold_pct::float,
        b.critical_threshold_pct::float,
        b.enforcement_mode,
        b.is_active,
        COALESCE((
          SELECT SUM(t.cost_usd)::float
          FROM transactions t
          WHERE t.organization_id = b.organization_id
            AND CASE b.period
                  WHEN 'daily' THEN t.created_at >= date_trunc('day', now())
                  WHEN 'weekly' THEN t.created_at >= date_trunc('week', now())
                  WHEN 'monthly' THEN t.created_at >= date_trunc('month', now())
                  ELSE false
                END
        ), 0.0) AS used_usd
       FROM budgets b
       WHERE b.organization_id = $1 AND b.is_active = true
       ORDER BY b.created_at DESC`,
      [session.orgId]
    );

    const budgetsWithPct = rows.map((r: any) => ({
      ...r,
      percent_used: r.cap_usd > 0 ? Math.round((r.used_usd / r.cap_usd) * 1000) / 10 : 0,
    }));

    return NextResponse.json({ budgets: budgetsWithPct });
  } catch (err: any) {
    console.error('[Budgets API GET Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();
  if (!can(session.role, 'budget:write')) return forbiddenResponse();

  try {
    const body = await req.json();
    const {
      name,
      scope_type = 'organization',
      scope_id = session.orgId,
      cap_usd,
      period = 'monthly',
      warn_threshold_pct = 80,
      critical_threshold_pct = 90,
      enforcement_mode = 'hard_cap',
    } = body;

    if (!cap_usd || Number(cap_usd) <= 0) {
      return NextResponse.json(
        { error: { message: 'cap_usd is required and must be greater than 0' } },
        { status: 400 }
      );
    }

    const dbUp = await isDbAvailable();
    if (!dbUp) {
      return NextResponse.json({
        success: true,
        budget: {
          id: Date.now().toString(),
          name: name || 'New Budget',
          scope_type,
          scope_id,
          cap_usd: Number(cap_usd),
          period,
          warn_threshold_pct,
          critical_threshold_pct,
          enforcement_mode,
          is_active: true,
        },
      });
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO budgets (
        organization_id, scope_type, scope_id, name, cap_usd, period,
        warn_threshold_pct, critical_threshold_pct, enforcement_mode, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
      RETURNING id::text, public_id::text, name, cap_usd::float, period, enforcement_mode`,
      [
        session.orgId,
        scope_type,
        scope_id,
        name || `${scope_type.toUpperCase()} Budget`,
        String(cap_usd),
        period,
        warn_threshold_pct,
        critical_threshold_pct,
        enforcement_mode,
      ]
    );

    return NextResponse.json({ success: true, budget: rows[0] });
  } catch (err: any) {
    console.error('[Budgets API POST Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();
  if (!can(session.role, 'budget:write')) return forbiddenResponse();

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: { message: 'Budget id is required' } }, { status: 400 });
  }

  const dbUp = await isDbAvailable();
  if (!dbUp) {
    return NextResponse.json({ success: true });
  }

  try {
    const pool = getPool();
    await pool.query(
      `UPDATE budgets SET is_active = false WHERE (id::text = $1 OR public_id::text = $1) AND organization_id = $2`,
      [id, session.orgId]
    );
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[Budgets API DELETE Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

