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
    let orgId = '1';
    let userPublicId = '00000000-0000-0000-0000-000000000001';
    let role: Role = 'owner';

    if (dbUp) {
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

      orgId = rows[0].organization_id;
      userPublicId = rows[0].public_id;
      role = (rows[0].role as Role) || 'viewer';
    } else {
      // Dev mode fallback
      if (password !== 'password123' && process.env.NODE_ENV === 'production') {
        return NextResponse.json(
          { error: { message: 'Invalid credentials' } },
          { status: 401 }
        );
      }
    }

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

