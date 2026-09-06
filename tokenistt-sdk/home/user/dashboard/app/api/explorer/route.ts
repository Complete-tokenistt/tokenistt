import { NextRequest, NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';
import { getSessionFromRequest, unauthorizedResponse } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const searchParams = req.nextUrl.searchParams;
  const dimension = searchParams.get('groupBy') || 'provider'; // provider | model | cost_center | day
  const days = parseInt(searchParams.get('days') || '30', 10);

  const dbUp = await isDbAvailable();
  if (!dbUp) {
    return NextResponse.json({
      dimension,
      series: [
        { label: 'openai', cost: 12450.32, requests: 142000, tokens: 48200000 },
        { label: 'anthropic', cost: 8920.15, requests: 62000, tokens: 29100000 },
        { label: 'bedrock', cost: 3100.50, requests: 28000, tokens: 12000000 },
        { label: 'azure', cost: 2150.00, requests: 19000, tokens: 8500000 },
      ],
      totalCost: 26620.97,
    });
  }

  try {
    const pool = getPool();
    let groupColumn = 't.provider';
    if (dimension === 'model') groupColumn = 't.model';
    if (dimension === 'cost_center') groupColumn = "COALESCE(t.cost_center, 'default')";
    if (dimension === 'day') groupColumn = "to_char(t.created_at, 'YYYY-MM-DD')";

    const { rows } = await pool.query(
      `SELECT 
        ${groupColumn} AS label,
        SUM(t.cost_usd)::float AS cost,
        COUNT(*)::int AS requests,
        SUM(t.total_tokens)::bigint AS tokens
       FROM transactions t
       WHERE t.organization_id = $1
         AND t.created_at >= now() - ($2 || ' days')::interval
       GROUP BY ${groupColumn}
       ORDER BY cost DESC`,
      [session.orgId, days]
    );

    const totalCost = rows.reduce((acc, r) => acc + (r.cost || 0), 0);
    return NextResponse.json({
      dimension,
      series: rows,
      totalCost: Math.round(totalCost * 100) / 100,
    });
  } catch (err: any) {
    console.error('[Cost Explorer API Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

