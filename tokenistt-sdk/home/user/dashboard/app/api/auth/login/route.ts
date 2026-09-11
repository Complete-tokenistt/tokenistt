import { NextRequest, NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';
import { verifyPassword, signJwt } from '@/lib/auth';
import { Role } from '@/lib/rbac';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: { message: 'Email and password are required' } },
        { status: 400 }
      );
    }

    const dbUp = await isDbAvailable();

    // In production, NEVER authenticate without the database.
    // Development fallback is strictly isolated behind NODE_ENV !== 'production' AND STRICT_AUTH not set.
    if (!dbUp) {
      if (process.env.NODE_ENV === 'production' || process.env.STRICT_AUTH === 'true') {
        return NextResponse.json(
          { error: { message: 'Authentication service unavailable. Please try again shortly.' } },
          { status: 503 }
        );
      }

      // ── Development only fallback ─────────────────────────────────────────
      // This block is only reachable when NODE_ENV !== 'production' AND STRICT_AUTH is not set (guarded above).
      // Does NOT accept any fixed password — just returns a dev session.
      const devToken = signJwt({
        sub: '00000000-0000-0000-0000-000000000001',
        orgId: '1',
        email: email.toLowerCase(),
        role: 'owner' as Role,
      });
      const devResponse = NextResponse.json({
        success: true,
        token: devToken,
        user: { publicId: '00000000-0000-0000-0000-000000000001', orgId: '1', email: email.toLowerCase(), role: 'owner' },
        _dev_mode: true,
      });
      devResponse.cookies.set('tokenistt_session', devToken, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
        maxAge: 86400,
      });
      return devResponse;
    }


    // ── Production path: DB must be available ─────────────────────────────
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id::text, public_id::text, organization_id::text, email, password_hash, role
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [email.toLowerCase()]
    );

    if (rows.length === 0 || !rows[0].password_hash) {
      return NextResponse.json(
        { error: { message: 'Invalid email or password' } },
        { status: 401 }
      );
    }

    const isValid = await verifyPassword(password, rows[0].password_hash);
    if (!isValid) {
      return NextResponse.json(
        { error: { message: 'Invalid email or password' } },
        { status: 401 }
      );
    }

    const orgId = rows[0].organization_id;
    const userPublicId = rows[0].public_id;
    const role = (rows[0].role as Role) || 'viewer';

    const token = signJwt({
      sub: userPublicId,
      orgId,
      email: email.toLowerCase(),
      role,
    });

    const response = NextResponse.json({
      success: true,
      token,
      user: {
        publicId: userPublicId,
        orgId,
        email: email.toLowerCase(),
        role,
      },
    });

    response.cookies.set('tokenistt_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 86400,
    });

    return response;
  } catch (err: any) {
    console.error('[Auth Login Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
