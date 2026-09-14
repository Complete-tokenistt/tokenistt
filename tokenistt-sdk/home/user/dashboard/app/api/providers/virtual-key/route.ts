import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { API_KEYS } from "@/lib/dashboard-mock-data";

/**
 * GET /api/providers/virtual-key
 * Returns an active virtual key for the organization.
 */
export async function GET() {
  if (!process.env.DATABASE_URL) {
    const mockKey = API_KEYS[0] || {
      id: "vk_mock",
      name: "Default Dev Key",
      prefix: "tktt_live_acme_jane_abc123def456",
      budget: 100,
      period: "monthly",
    };
    return NextResponse.json({
      success: true,
      key: {
        id: mockKey.id,
        name: mockKey.name,
        prefix: mockKey.prefix,
        hasRealKey: false,
      },
    });
  }

  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      name: string;
      key_prefix: string;
      status: string;
      metadata: any;
      created_at: string;
    }>(
      `
      SELECT id::text, name, key_prefix, status, metadata, created_at
      FROM virtual_keys
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
      `
    );

    if (rows.length === 0) {
      return NextResponse.json({
        success: true,
        key: {
          id: "vk_default",
          name: "Default Key",
          prefix: "tktt_live_acme_jane_abc123def456",
          hasRealKey: false,
        },
      });
    }

    const row = rows[0];
    return NextResponse.json({
      success: true,
      key: {
        id: row.id,
        name: row.name,
        prefix: row.key_prefix,
        hasRealKey: Boolean(row.metadata?.real_api_key),
      },
    });
  } catch (err: any) {
    console.error("[/api/providers/virtual-key] DB error:", err.message);
    return NextResponse.json({
      success: true,
      key: {
        id: "vk_fallback",
        name: "Fallback Key",
        prefix: "tktt_live_acme_jane_abc123def456",
        hasRealKey: false,
      },
    });
  }
}

