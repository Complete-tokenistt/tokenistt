/**
 * POST /api/reconciliation
 *
 * Reconciles uploaded vendor invoice totals against calculated database ledger totals
 * for the current calendar month.
 *
 * Falls back to mock data when DATABASE_URL is not configured.
 */

import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { reconcile } from "@/lib/mock-data";
import { PROVIDER_LABELS } from "@/lib/format";
import type { InvoiceLine, ReconciliationRow, ReconciliationStatus } from "@/lib/types";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { invoices?: InvoiceLine[] };
    const invoices = body.invoices ?? [];

    // ── Fallback: no DB ────────────────────────────────────────────────────────
    if (!process.env.DATABASE_URL) {
      return NextResponse.json({ rows: await reconcile(invoices) });
    }

    const pool = getPool();

    // Query actual monthly spend per provider from Postgres
    const { rows: dbRows } = await pool.query<{ provider: string; spend: string }>(`
      SELECT provider,
             SUM(cost_usd)::text AS spend
      FROM   transactions
      WHERE  status = 'success'
        AND  created_at >= date_trunc('month', now())
      GROUP  BY provider
    `);

    // Map DB spend values
    const calculated: Record<string, number> = {};
    for (const r of dbRows) {
      calculated[r.provider.toLowerCase()] = parseFloat(r.spend);
    }

    const seen = new Set<string>();

    // Compare invoice lines against actual database numbers
    const reconRows: ReconciliationRow[] = invoices.map((inv) => {
      const key = inv.provider.toLowerCase();
      seen.add(key);
      const calc = calculated[key] ?? 0;
      const variance = inv.billedUsd - calc;
      const variancePct = calc === 0 ? 100 : (variance / calc) * 100;

      let status: ReconciliationStatus = "matched";
      if (Math.abs(variancePct) <= 1) status = "matched";
      else if (variance > 0) status = "over-billed";
      else status = "under-billed";

      return {
        provider: PROVIDER_LABELS[key] ?? key,
        calculatedUsd: calc,
        billedUsd: inv.billedUsd,
        varianceUsd: parseFloat(variance.toFixed(2)),
        variancePct: parseFloat(variancePct.toFixed(2)),
        status,
      };
    });

    // Add entries for providers in our database not covered by the invoice
    for (const [key, calc] of Object.entries(calculated)) {
      if (!seen.has(key)) {
        reconRows.push({
          provider: PROVIDER_LABELS[key] ?? key,
          calculatedUsd: calc,
          billedUsd: 0,
          varianceUsd: -calc,
          variancePct: -100,
          status: "missing",
        });
      }
    }

    return NextResponse.json({ rows: reconRows });
  } catch (err: any) {
    console.error("[/api/reconciliation] DB error, falling back to mock:", err.message);
    try {
      const body = (await req.json()) as { invoices?: InvoiceLine[] };
      return NextResponse.json({ rows: await reconcile(body.invoices ?? []) });
    } catch {
      return NextResponse.json({ error: "Invalid request or database error" }, { status: 500 });
    }
  }
}
