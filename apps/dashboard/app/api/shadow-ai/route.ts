/**
 * GET /api/shadow-ai
 *
 * Returns shadow AI events. Merges:
 *   1. Scans ingested from external OAuth card processing (shadow-ai-ingest.json).
 *   2. Transactions flagged with shadow_ai_flag = true in the Postgres database.
 */

import { NextRequest, NextResponse } from "next/server";
import { dbUnavailable } from "@/lib/db-unavailable";
import { getPool } from "@/lib/db";
import { getSessionFromRequest, unauthorizedResponse } from "@/lib/auth";
import { loadIngestedShadowAi } from "@/lib/ingest";
import type { ShadowAiEvent } from "@/lib/types";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  if (!process.env.DATABASE_URL) return dbUnavailable();

  try {
    const pool = getPool();
    
    // 1. Fetch transactions flagged as shadow AI in Postgres for this organization
    const { rows } = await pool.query<{
      public_id: string;
      created_at: string;
      actor: string | null;
      provider: string;
      cost_usd: string;
      metadata: any;
    }>(`
      SELECT public_id,
             created_at::text AS created_at,
             actor,
             provider,
             cost_usd::text AS cost_usd,
             metadata
      FROM   transactions
      WHERE  organization_id = $1
        AND  shadow_ai_flag = true
      ORDER  BY created_at DESC
      LIMIT  50
    `, [session.orgId]);

    // Map Postgres rows to UI ShadowAiEvent shape
    const dbEvents: ShadowAiEvent[] = rows.map((r) => ({
      id: r.public_id,
      detectedAt: r.created_at,
      actor: r.actor ?? "unknown",
      source: "gateway-detection",
      vendor: r.provider,
      amountUsd: parseFloat(r.cost_usd),
      status: "unreviewed",
      note: r.metadata?.note ?? `Gateway flagged: unauthorized model access by ${r.actor}`,
    }));

    return NextResponse.json(dbEvents);
  } catch (err: any) {
    console.error("[/api/shadow-ai] DB error, returning empty list:", err.message);
    return dbUnavailable();
  }
}

