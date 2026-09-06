import { NextRequest, NextResponse } from "next/server";
import { getPool, isDbAvailable } from "@/lib/db";
import { getSessionFromRequest, unauthorizedResponse, forbiddenResponse } from "@/lib/auth";
import { can } from "@/lib/rbac";

// In-memory fallback for mock/demo mode when DATABASE_URL is not set
let mockPolicies = [
  {
    id: "1",
    public_id: "11111111-1111-1111-1111-111111111111",
    name: "Block GPT-4 for Interns",
    description: "Block high-cost GPT-4 model requests from the Intern cost center team.",
    is_enabled: true,
    conditions: { cost_center: "interns", model: "gpt-4" },
    actions: { effect: "block", message: "GPT-4 access is forbidden for the Intern team to manage budgets." },
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    updated_at: new Date(Date.now() - 3600000 * 24).toISOString()
  },
  {
    id: "2",
    public_id: "22222222-2222-2222-2222-222222222222",
    name: "Require Approval for High Cost",
    description: "Require approval for any API request with estimated cost exceeding $0.50.",
    is_enabled: true,
    conditions: { cost_limit: 0.50 },
    actions: { effect: "require_approval", message: "Request exceeds the policy pre-flight limit of $0.50. Approval is required." },
    created_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    updated_at: new Date(Date.now() - 3600000 * 12).toISOString()
  },
  {
    id: "3",
    public_id: "33333333-3333-3333-3333-333333333333",
    name: "Force Haiku for Summarization",
    description: "Redirect any summarization tasks calling GPT-4 to the cost-efficient Claude 3 Haiku model.",
    is_enabled: false,
    conditions: { prompt_keyword: "summarize", model: "gpt-4" },
    actions: { effect: "force_model", model: "claude-3-haiku" },
    created_at: new Date(Date.now() - 3600000 * 6).toISOString(),
    updated_at: new Date(Date.now() - 3600000 * 6).toISOString()
  }
];

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const dbUp = await isDbAvailable();
  if (!dbUp) {
    return NextResponse.json(mockPolicies);
  }

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
    console.error("[/api/policies] DB list error, returning mock fallback:", err.message);
    return NextResponse.json(mockPolicies);
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
    if (!dbUp) {
      const newPolicy = {
        id: String(mockPolicies.length + 1),
        public_id: crypto.randomUUID(),
        name,
        description: description || "",
        is_enabled: is_enabled !== false,
        conditions: conditions || {},
        actions: actions || { effect: "block" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      mockPolicies.unshift(newPolicy);
      return NextResponse.json(newPolicy);
    }

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
    if (!dbUp) {
      const idx = mockPolicies.findIndex(p => p.public_id === public_id);
      if (idx === -1) {
        return NextResponse.json({ error: "Policy not found" }, { status: 404 });
      }
      mockPolicies[idx] = {
        ...mockPolicies[idx],
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(is_enabled !== undefined && { is_enabled }),
        ...(conditions !== undefined && { conditions }),
        ...(actions !== undefined && { actions }),
        updated_at: new Date().toISOString()
      };
      return NextResponse.json(mockPolicies[idx]);
    }

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
    if (!dbUp) {
      const idx = mockPolicies.findIndex(p => p.public_id === public_id);
      if (idx === -1) {
        return NextResponse.json({ error: "Policy not found" }, { status: 404 });
      }
      mockPolicies.splice(idx, 1);
      return NextResponse.json({ success: true });
    }

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
