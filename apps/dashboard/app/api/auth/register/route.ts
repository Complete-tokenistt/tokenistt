import { NextRequest, NextResponse } from 'next/server';
import { getPool, isDbAvailable } from '@/lib/db';
import { hashPassword, signJwt } from '@/lib/auth';

/**
 * First-admin bootstrap only.
 *
 * This route creates the owner of a fresh install. Once any user with a
 * password exists it is closed (403); further users must be added by an
 * existing owner. It never touches an existing organization's users, and it
 * does not alter the schema (see migration 0006).
 */
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

    if (typeof password !== 'string' || password.length < 8) {
      return NextResponse.json(
        { error: { message: 'Password must be at least 8 characters long' } },
        { status: 400 }
      );
    }

    if (!(await isDbAvailable())) {
      return NextResponse.json(
        { error: { message: 'Database unavailable' } },
        { status: 503 }
      );
    }

    const hashedPassword = await hashPassword(password);
    const normalizedEmail = String(email).toLowerCase();
    const pool = getPool();
    const client = await pool.connect();

    let orgId: string;
    let userPublicId: string;
    try {
      await client.query('BEGIN');
      // Serialise concurrent bootstrap attempts.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['tokenistt-bootstrap']);

      const existing = await client.query(
        'SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1'
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: { message: 'Setup already completed. Ask an existing owner to add you.' } },
          { status: 403 }
        );
      }

      // Reuse the seeded workspace org if one exists, otherwise create it.
      const orgRows = await client.query(
        'SELECT id::text FROM organizations ORDER BY id LIMIT 1'
      );
      if (orgRows.rows.length > 0) {
        orgId = orgRows.rows[0].id;
      } else {
        const slug = String(orgName).toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 32) || 'org';
        const created = await client.query(
          `INSERT INTO organizations (name, slug, plan)
           VALUES ($1, $2, 'starter')
           RETURNING id::text`,
          [orgName, slug]
        );
        orgId = created.rows[0].id;
      }

      const userRes = await client.query(
        `INSERT INTO users (organization_id, email, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'owner')
         RETURNING public_id::text`,
        [orgId, normalizedEmail, displayName || normalizedEmail.split('@')[0], hashedPassword]
      );
      userPublicId = userRes.rows[0].public_id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const token = signJwt({
      sub: userPublicId,
      orgId,
      email: normalizedEmail,
      role: 'owner',
    });

    const response = NextResponse.json({
      success: true,
      token,
      user: { publicId: userPublicId, orgId, email: normalizedEmail, role: 'owner' },
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
    return NextResponse.json({ error: { message: 'Registration failed' } }, { status: 500 });
  }
}
