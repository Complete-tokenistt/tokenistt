import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { encryptApiKey } from "@/lib/vault";

// In-memory mock keys for standalone demo mode
let mockKeys: Record<string, boolean> = {
  openai: true,
  anthropic: false
};

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(mockKeys);
  }

  try {
    const pool = getPool();
    
    // We fetch virtual keys and check if they have real provider keys configured
    const { rows: vkRows } = await pool.query<{ metadata: any }>(
      "SELECT metadata FROM virtual_keys WHERE status = 'active'"
    );

    const hasOpenAI = vkRows.some(r => r.metadata?.real_api_key);
    const hasAnthropic = vkRows.some(r => r.metadata?.real_api_key && r.metadata.real_api_key.includes("anthropic"));

    return NextResponse.json({
      openai: hasOpenAI,
      anthropic: hasAnthropic
    });

  } catch (err: any) {
    console.error("[/api/settings/keys] GET error, returning mock status:", err.message);
    return NextResponse.json(mockKeys);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { provider, apiKey } = body;

    if (!provider || !apiKey) {
      return NextResponse.json({ error: "Provider and apiKey are required" }, { status: 400 });
    }

    if (!process.env.DATABASE_URL) {
      mockKeys[provider.toLowerCase()] = true;
      return NextResponse.json({ success: true, provider, mock: true });
    }

    const pool = getPool();

    // 1. Resolve first organization ID
    const { rows: orgRows } = await pool.query<{ id: string }>(
      "SELECT id::text FROM organizations LIMIT 1"
    );
    const orgId = orgRows[0]?.id || "1";

    // 2. Encrypt the API key securely using AES-256-GCM
    const encryptedKey = encryptApiKey(apiKey, orgId);

    // 3. Update virtual_keys to inject this encrypted key in metadata for key routing
    await pool.query(`
      UPDATE virtual_keys
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{real_api_key}', $2)
      WHERE organization_id = $1
    `, [orgId, JSON.stringify(encryptedKey)]);

    // 4. Update the organization settings block as well
    await pool.query(`
      UPDATE organizations
      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{real_api_key}', $2)
      WHERE id = $1
    `, [orgId, JSON.stringify(encryptedKey)]);

    return NextResponse.json({ success: true, provider });

  } catch (err: any) {
    console.error("[/api/settings/keys] POST error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
