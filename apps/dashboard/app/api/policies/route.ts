import { NextRequest, NextResponse } from "next/server";
import { getPool, isDbAvailable } from "@/lib/db";
import { getSessionFromRequest, unauthorizedResponse, forbiddenResponse } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { dbUnavailable } from "@/lib/db-unavailable";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const dbUp = await isDbAvailable();
  if (!dbUp) return dbUnavailable();

  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT id::text, public_id::text, name, description, is_enabled, conditions, actions, created_at, updated_at
      FROM policies
      WHERE organization_id IS NULL OR organization_id = $1
      ORDER BY created_at DESC
    `, [session.orgId]);
    return NextResponse.json(rows);
  } catch (err: any) {
    console.error("[/api/policies] DB list error:", err.message);
    return dbUnavailable();
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();
  if (!can(session.role, 'policies:write')) return forbiddenResponse();

  try {
    const body = await req.json();
    const { name, description, is_enabled, conditions, actions } = body;

    if (!name) {
      return NextResponse.json({ error: "Policy name is required" }, { status: 400 });
    }

    const dbUp = await isDbAvailable();
    if (!dbUp) return dbUnavailable();

    const pool = getPool();
    const { rows } = await pool.query(`
      INSERT INTO policies (organization_id, name, description, is_enabled, conditions, actions)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id::text, public_id::text, name, description, is_enabled, conditions, actions, created_at, updated_at
    `, [
      session.orgId,
      name,
      description || "",
      is_enabled !== false,
      JSON.stringify(conditions || {}),
      JSON.stringify(actions || { effect: "block" })
    ]);

    return NextResponse.json(rows[0]);
  } catch (err: any) {
    console.error("[/api/policies] DB create error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();
  if (!can(session.role, 'policies:write')) return forbiddenResponse();

  try {
    const body = await req.json();
    const { public_id, is_enabled, name, description, conditions, actions } = body;

    if (!public_id) {
      return NextResponse.json({ error: "Policy public_id is required" }, { status: 400 });
    }

    const dbUp = await isDbAvailable();
    if (!dbUp) return dbUnavailable();

    const pool = getPool();
    const { rows } = await pool.query(`
      UPDATE policies
      SET 
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        is_enabled = COALESCE($4, is_enabled),
        conditions = COALESCE($5, conditions),
        actions = COALESCE($6, actions),
        updated_at = now()
      WHERE public_id = $1 AND (organization_id IS NULL OR organization_id = $7)
      RETURNING id::text, public_id::text, name, description, is_enabled, conditions, actions, created_at, updated_at
    `, [
      public_id,
      name !== undefined ? name : null,
      description !== undefined ? description : null,
      is_enabled !== undefined ? is_enabled : null,
      conditions !== undefined ? JSON.stringify(conditions) : null,
      actions !== undefined ? JSON.stringify(actions) : null,
      session.orgId
    ]);

    if (rows.length === 0) {
      return NextResponse.json({ error: "Policy not found" }, { status: 404 });
    }

    return NextResponse.json(rows[0]);
  } catch (err: any) {
    console.error("[/api/policies] DB update error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();
  if (!can(session.role, 'policies:write')) return forbiddenResponse();

  try {
    const { searchParams } = new URL(req.url);
    const public_id = searchParams.get("public_id");

    if (!public_id) {
      return NextResponse.json({ error: "Policy public_id query param is required" }, { status: 400 });
    }

    const dbUp = await isDbAvailable();
    if (!dbUp) return dbUnavailable();

    const pool = getPool();
    const { rowCount } = await pool.query(`
      DELETE FROM policies
      WHERE public_id = $1 AND (organization_id IS NULL OR organization_id = $2)
    `, [public_id, session.orgId]);

    if (rowCount === 0) {
      return NextResponse.json({ error: "Policy not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("[/api/policies] DB delete error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
