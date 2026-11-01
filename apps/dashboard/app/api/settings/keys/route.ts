import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { encryptApiKey } from "@/lib/vault";
import { getSessionFromRequest, unauthorizedResponse, forbiddenResponse } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { dbUnavailable } from "@/lib/db-unavailable";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  if (!process.env.DATABASE_URL) return dbUnavailable();

  try {
    const pool = getPool();

    // Fetch virtual keys scoped to this user's organization
    const { rows: vkRows } = await pool.query<{ metadata: any }>(
      "SELECT metadata FROM virtual_keys WHERE organization_id = $1 AND status = 'active'",
      [session.orgId]
    );

    const hasOpenAI = vkRows.some((r) => r.metadata?.real_api_key);
    const hasAnthropic = vkRows.some(
      (r) => r.metadata?.real_api_key && r.metadata.real_api_key.includes("anthropic")
    );

    return NextResponse.json({
      openai: hasOpenAI,
      anthropic: hasAnthropic,
    });
  } catch (err: any) {
    console.error("[/api/settings/keys] GET error:", err.message);
    return dbUnavailable();
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  if (!can(session.role, "keys:write")) {
    return forbiddenResponse("Insufficient permissions to configure provider keys");
  }

  try {
    const body = await req.json();
    const { provider, apiKey } = body;

    if (!provider || !apiKey) {
      return NextResponse.json({ error: "Provider and apiKey are required" }, { status: 400 });
    }

    if (!process.env.DATABASE_URL) return dbUnavailable();

    const pool = getPool();
    const orgId = session.orgId;

    // 1. Encrypt the API key securely using AES-256-GCM
    const encryptedKey = encryptApiKey(apiKey, orgId);

    // 2. Update virtual_keys scoped to this organization
    await pool.query(
      `
      UPDATE virtual_keys
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{real_api_key}', $2)
      WHERE organization_id = $1
    `,
      [orgId, JSON.stringify(encryptedKey)]
    );

    // 3. Update the organization settings block as well
    await pool.query(
      `
      UPDATE organizations
      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{real_api_key}', $2)
      WHERE id = $1
    `,
      [orgId, JSON.stringify(encryptedKey)]
    );

    return NextResponse.json({ success: true, provider });
  } catch (err: any) {
    console.error("[/api/settings/keys] POST error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
