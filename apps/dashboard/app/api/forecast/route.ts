import { NextRequest, NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';
import { getSessionFromRequest, unauthorizedResponse } from '@/lib/auth';

interface DailyPoint {
  date: string;
  cost: number;
}

function calculateLinearRegression(data: DailyPoint[], totalDaysInMonth: number) {
  if (data.length === 0) {
    return { projectedTotal: 0, slope: 0, r2: 0 };
  }

  const n = data.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;

  data.forEach((p, idx) => {
    const x = idx + 1;
    const y = p.cost;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
    sumYY += y * y;
  });

  const slope = n > 1 && (n * sumXX - sumX * sumX) !== 0
    ? (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)
    : 0;
  const intercept = (sumY - slope * sumX) / n;

  // Sum actual spend to date + project future days
  let projectedTotal = 0;
  for (let day = 1; day <= totalDaysInMonth; day++) {
    if (day <= n) {
      projectedTotal += data[day - 1].cost;
    } else {
      const predictedDaily = Math.max(0, slope * day + intercept);
      projectedTotal += predictedDaily;
    }
  }

  return {
    projectedTotal: Math.round(projectedTotal * 100) / 100,
    slope: Math.round(slope * 1000) / 1000,
  };
}

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
      budgetHealthStatus: 'on_track',
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
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    // 1. Daily spend for current month to date
    const [spendRes, capRes] = await Promise.all([
      pool.query<DailyPoint>(
        `SELECT 
          to_char(t.created_at, 'YYYY-MM-DD') AS date,
          SUM(t.cost_usd)::float AS cost
         FROM transactions t
         WHERE t.organization_id = $1
           AND t.status = 'success'
           AND t.created_at >= date_trunc('month', now())
         GROUP BY to_char(t.created_at, 'YYYY-MM-DD')
         ORDER BY date ASC`,
        [session.orgId]
      ),
      pool.query<{ cap: string }>(
        `SELECT COALESCE(SUM(budget_cap_usd), 25000)::text AS cap
         FROM workspaces
         WHERE organization_id = $1`,
        [session.orgId]
      ),
    ]);

    const dailyRows = spendRes.rows;
    const daysElapsed = Math.max(1, dailyRows.length);
    const mtdSpend = dailyRows.reduce((acc, r) => acc + (r.cost || 0), 0);
    const dailyBurnRate = mtdSpend / daysElapsed;
    const budgetCap = parseFloat(capRes.rows[0]?.cap || '25000');

    // 2. Statistical Linear Trend Projection
    const regression = calculateLinearRegression(dailyRows, daysInMonth);
    const forecastedTotal = regression.projectedTotal > 0 ? regression.projectedTotal : Math.round(dailyBurnRate * daysInMonth * 100) / 100;

    const budgetHealthStatus =
      forecastedTotal > budgetCap
        ? 'critical_exceeded'
        : forecastedTotal > budgetCap * 0.85
        ? 'warning'
        : 'on_track';

    return NextResponse.json({
      currentSpendMonthToDate: Math.round(mtdSpend * 100) / 100,
      forecastedMonthEndSpend: forecastedTotal,
      dailyBurnRate: Math.round(dailyBurnRate * 100) / 100,
      budgetCap,
      budgetHealthStatus,
      trendSlope: regression.slope,
      historicalDaily: dailyRows,
    });
  } catch (err: any) {
    console.error('[Forecast API Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
