import { NextRequest, NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';
import { getSessionFromRequest, unauthorizedResponse } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const dbUp = await isDbAvailable();
  if (!dbUp) {
    return NextResponse.json({
      currentSpendMonthToDate: 14250.80,
      forecastedMonthEndSpend: 28500.00,
      dailyBurnRate: 950.05,
      budgetCap: 30000.00,
      budgetHealthStatus: 'on_track', // on_track | warning | critical_exceeded
      historicalDaily: [
        { date: '2026-03-01', cost: 920.10 },
        { date: '2026-03-02', cost: 980.50 },
        { date: '2026-03-03', cost: 940.00 },
        { date: '2026-03-04', cost: 1010.20 },
        { date: '2026-03-05', cost: 950.00 },
      ],
    });
  }

  try {
    const pool = getPool();
    // Daily spend for last 30 days
    const { rows } = await pool.query(
      `SELECT 
        to_char(t.created_at, 'YYYY-MM-DD') AS date,
        SUM(t.cost_usd)::float AS cost
       FROM transactions t
       WHERE t.organization_id = $1
         AND t.created_at >= date_trunc('month', now())
       GROUP BY to_char(t.created_at, 'YYYY-MM-DD')
       ORDER BY date ASC`,
      [session.orgId]
    );

    const daysElapsed = Math.max(1, rows.length);
    const mtdSpend = rows.reduce((acc, r) => acc + (r.cost || 0), 0);
    const dailyBurnRate = mtdSpend / daysElapsed;

    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const forecastedTotal = dailyBurnRate * daysInMonth;

    return NextResponse.json({
      currentSpendMonthToDate: Math.round(mtdSpend * 100) / 100,
      forecastedMonthEndSpend: Math.round(forecastedTotal * 100) / 100,
      dailyBurnRate: Math.round(dailyBurnRate * 100) / 100,
      budgetCap: 25000.0,
      budgetHealthStatus: forecastedTotal > 25000 ? 'warning' : 'on_track',
      historicalDaily: rows,
    });
  } catch (err: any) {
    console.error('[Forecast API Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

