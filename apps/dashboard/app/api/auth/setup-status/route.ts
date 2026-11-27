import { NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';

/** Public: tells the login page whether to offer first-run owner setup. */
export async function GET() {
  if (!(await isDbAvailable())) {
    return NextResponse.json({ error: { message: 'Database unavailable' } }, { status: 503 });
  }
  const { rows } = await getPool().query(
    'SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1'
  );
  return NextResponse.json({ needsSetup: rows.length === 0 });
}
