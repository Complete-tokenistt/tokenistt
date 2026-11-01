import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest, isOpenMode, unauthorizedResponse } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) {
    return unauthorizedResponse('Not authenticated');
  }

  return NextResponse.json({
    authenticated: true,
    open: isOpenMode(),
    user: {
      publicId: session.sub,
      orgId: session.orgId,
      email: session.email,
      role: session.role,
    },
  });
}

