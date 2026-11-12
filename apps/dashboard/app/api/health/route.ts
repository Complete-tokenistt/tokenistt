import { NextResponse } from 'next/server';
import { isDbAvailable } from '@/lib/db';

// Public liveness/readiness probe for container healthchecks and load balancers.
export const dynamic = 'force-dynamic';

export async function GET() {
  const db = await isDbAvailable();
  return NextResponse.json(
    { status: db ? 'ok' : 'degraded', database: db ? 'connected' : 'unreachable' },
    { status: db ? 200 : 503 }
  );
}
