import { NextRequest, NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';
import { dbUnavailable } from '@/lib/db-unavailable';
import { getSessionFromRequest, unauthorizedResponse } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const searchParams = req.nextUrl.searchParams;
  const dimension = searchParams.get('groupBy') || 'provider';
  const daysParam = searchParams.get('days');
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const providerFilter = searchParams.get('provider');
  const modelFilter = searchParams.get('model');

  const dbUp = await isDbAvailable();
  if (!dbUp) return dbUnavailable();

  try {
    const pool = getPool();
    let groupColumn = 't.provider';

    switch (dimension) {
      case 'model':
        groupColumn = 't.model';
        break;
      case 'cost_center':
        groupColumn = "COALESCE(t.cost_center, 'default')";
        break;
      case 'day':
        groupColumn = "to_char(t.created_at, 'YYYY-MM-DD')";
        break;
      case 'week':
        groupColumn = "to_char(date_trunc('week', t.created_at), 'YYYY-MM-DD')";
        break;
      case 'month':
        groupColumn = "to_char(date_trunc('month', t.created_at), 'YYYY-MM')";
        break;
      case 'actor':
        groupColumn = "COALESCE(t.actor, 'anonymous')";
        break;
      case 'project_tag':
        groupColumn = "COALESCE(t.project_tag, 'untagged')";
        break;
      case 'virtual_key':
        groupColumn = "COALESCE(t.virtual_key_id::text, 'direct')";
        break;
      default:
        groupColumn = 't.provider';
    }

    const conditions: string[] = ['t.organization_id = $1', "t.status = 'success'"];
    const params: any[] = [session.orgId];
    let pIdx = 2;

    if (startDate && endDate) {
      conditions.push(`t.created_at >= $${pIdx}::timestamptz AND t.created_at <= $${pIdx + 1}::timestamptz`);
      params.push(startDate, endDate);
      pIdx += 2;
    } else {
      const days = parseInt(daysParam || '30', 10);
      conditions.push(`t.created_at >= now() - ($${pIdx} || ' days')::interval`);
      params.push(days);
      pIdx++;
    }

    if (providerFilter) {
      conditions.push(`LOWER(t.provider) = LOWER($${pIdx})`);
      params.push(providerFilter);
      pIdx++;
    }

    if (modelFilter) {
      conditions.push(`LOWER(t.model) = LOWER($${pIdx})`);
      params.push(modelFilter);
      pIdx++;
    }

    const query = `
      SELECT 
        ${groupColumn} AS label,
        SUM(t.cost_usd)::float AS cost,
        COUNT(*)::int AS requests,
        SUM(t.total_tokens)::bigint AS tokens,
        SUM(t.prompt_tokens)::bigint AS input_tokens,
        SUM(t.completion_tokens)::bigint AS output_tokens,
        SUM(t.cache_read_tokens)::bigint AS cache_read_tokens,
        SUM(t.cache_creation_tokens)::bigint AS cache_creation_tokens
      FROM transactions t
      WHERE ${conditions.join(' AND ')}
      GROUP BY ${groupColumn}
      ORDER BY cost DESC
    `;

    const { rows } = await pool.query(query, params);

    const totalCost = rows.reduce((acc, r) => acc + (r.cost || 0), 0);
    const totalRequests = rows.reduce((acc, r) => acc + (r.requests || 0), 0);
    const totalTokens = rows.reduce((acc, r) => acc + Number(r.tokens || 0), 0);

    return NextResponse.json({
      dimension,
      series: rows.map(r => ({
        ...r,
        cost: Math.round(r.cost * 1000000) / 1000000,
      })),
      totalCost: Math.round(totalCost * 100) / 100,
      totalRequests,
      totalTokens,
    });
  } catch (err: any) {
    console.error('[Cost Explorer API Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
