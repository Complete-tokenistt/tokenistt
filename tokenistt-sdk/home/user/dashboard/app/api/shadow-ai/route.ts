/**
 * GET /api/shadow-ai
 *
 * Returns shadow AI events. Merges:
 *   1. Scans ingested from external OAuth card processing (shadow-ai-ingest.json).
 *   2. Transactions flagged with shadow_ai_flag = true in the Postgres database.
 *
 * Falls back to mock data when DATABASE_URL is not configured.
 */

import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getShadowAi } from "@/lib/mock-data";
import { loadIngestedShadowAi } from "@/lib/ingest";
import type { ShadowAiEvent } from "@/lib/types";

export async function GET() {
  // ── Fallback: no DB ────────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(await getShadowAi());
  }

  try {
    const pool = getPool();
    
    // 1. Fetch transactions flagged as shadow AI in Postgres
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
      WHERE  shadow_ai_flag = true
      ORDER  BY created_at DESC
      LIMIT  50
    `);

    // 2. Fetch ingested external scanner logs
    const scannerEvents = loadIngestedShadowAi();

    // Map Postgres rows to UI ShadowAiEvent shape
    const dbEvents: ShadowAiEvent[] = rows.map((r) => ({
      id: r.public_id,
      detectedAt: r.created_at,
      actor: r.actor ?? "unknown",
      source: "slack-integration", // default gateway categorization
      vendor: r.provider,
      amountUsd: parseFloat(r.cost_usd),
      status: "unreviewed",
      note: r.metadata?.note ?? `Gateway flagged: unauthorized model access by ${r.actor}`,
    }));

    // Merge both sources (DB first, then scanner)
    const merged = [...dbEvents, ...scannerEvents].sort(
      (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
    );

    return NextResponse.json(merged);
  } catch (err: any) {
    console.error("[/api/shadow-ai] DB error, falling back to mock:", err.message);
    return NextResponse.json(getShadowAi());
  }
}
