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
      alerts: [
        {
          id: '1',
          severity: 'warn',
          title: 'WARNING: Approaching Budget Limit',
          message: 'Workspace Support Bot is at 88.5% of its $5,000.00 monthly cap.',
          created_at: new Date(Date.now() - 3600000).toISOString(),
        },
        {
          id: '2',
          severity: 'critical',
          title: 'CRITICAL: Budget Limit Exceeded',
          message: 'Virtual key Sarah (dev) exceeded $500.00 monthly limit.',
          created_at: new Date(Date.now() - 86400000).toISOString(),
        },
      ],
    });
  }

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `
      SELECT 
        id::text,
        public_id::text,
        severity,
        title,
        message,
        channels,
        metadata,
        created_at
      FROM budget_alerts
      WHERE organization_id = $1
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [session.orgId]
    );

    return NextResponse.json({ alerts: rows });
  } catch (err: any) {
    console.error('[/api/alerts] Error fetching alerts:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  if (!can(session.role, 'budget:write')) {
    return forbiddenResponse('Insufficient permissions to manage budget alerts');
  }

  try {
    const body = await req.json();
    const { title, message, severity, channels, metadata } = body;

    if (!title || !message) {
      return NextResponse.json(
        { error: { message: 'Fields title and message are required' } },
        { status: 400 }
      );
    }

    const dbUp = await isDbAvailable();
    if (!dbUp) {
      return NextResponse.json({
        success: true,
        alert: {
          id: 'mock-new-alert',
          title,
          message,
          severity: severity || 'warn',
          created_at: new Date().toISOString(),
        },
      });
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `
      INSERT INTO budget_alerts (
        organization_id,
        severity,
        title,
        message,
        channels,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id::text, public_id::text, severity, title, message, created_at
      `,
      [
        session.orgId,
        severity || 'warn',
        title,
        message,
        JSON.stringify(channels || []),
        JSON.stringify(metadata || {}),
      ]
    );

    return NextResponse.json({ success: true, alert: rows[0] });
  } catch (err: any) {
    console.error('[/api/alerts] Error creating alert:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

