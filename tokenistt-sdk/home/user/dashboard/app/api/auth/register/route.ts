import { NextRequest, NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';
import { hashPassword, signJwt } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { orgName, email, password, displayName } = body;

    if (!orgName || !email || !password) {
      return NextResponse.json(
        { error: { message: 'Organization name, email, and password are required' } },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: { message: 'Password must be at least 8 characters long' } },
        { status: 400 }
      );
    }

    const hashedPassword = await hashPassword(password);
    const dbUp = await isDbAvailable();

    let orgId = '1';
    let userPublicId = '00000000-0000-0000-0000-000000000001';

    if (dbUp) {
      const pool = getPool();
      const slug = orgName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 32) || 'org';

      // 1. Create Organization
      const orgRes = await pool.query(
        `INSERT INTO organizations (name, slug, plan) 
         VALUES ($1, $2, 'starter') 
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name 
         RETURNING id::text, public_id::text`,
        [orgName, slug]
      );
      orgId = orgRes.rows[0].id;

      // 2. Ensure password_hash column exists on users table
      await pool.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'viewer';
      `);

      // 3. Create User with role 'owner'
      const userRes = await pool.query(
        `INSERT INTO users (organization_id, email, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'owner')
         ON CONFLICT (organization_id, external_ref) DO UPDATE 
         SET password_hash = EXCLUDED.password_hash, role = 'owner'
         RETURNING id::text, public_id::text, email, role`,
        [orgId, email.toLowerCase(), displayName || email.split('@')[0], hashedPassword]
      );
      userPublicId = userRes.rows[0].public_id;
    }

    const token = signJwt({
      sub: userPublicId,
      orgId,
      email: email.toLowerCase(),
      role: 'owner',
    });

    const response = NextResponse.json({
      success: true,
      token,
      user: {
        publicId: userPublicId,
        orgId,
        email: email.toLowerCase(),
        role: 'owner',
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
    console.error('[Auth Register Error]:', err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

