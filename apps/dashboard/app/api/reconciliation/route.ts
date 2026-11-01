/**
 * /api/reconciliation
 *
 * GET  — Returns existing provider invoices and reconciliation variance against the transactions ledger.
 * POST — Reconciles uploaded vendor invoice lines, calculates variance, and optionally persists to `provider_invoices`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPool, isDbAvailable } from "@/lib/db";
import { dbUnavailable } from "@/lib/db-unavailable";
import { PROVIDER_LABELS } from "@/lib/format";
import { getSessionFromRequest, unauthorizedResponse } from "@/lib/auth";
import type { InvoiceLine, ReconciliationRow, ReconciliationStatus } from "@/lib/types";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  const dbUp = await isDbAvailable();
  if (!dbUp) return dbUnavailable();

  try {
    const pool = getPool();

    // 1. Fetch uploaded provider invoices
    const { rows: invRows } = await pool.query<{
      id: string;
      provider: string;
      invoice_number: string | null;
      invoice_date: string;
      billed_amount_usd: string;
      net_amount_usd: string;
      status: string;
    }>(
      `
      SELECT 
        id::text,
        provider,
        invoice_number,
        invoice_date::text,
        billed_amount_usd::text,
        net_amount_usd::text,
        status
      FROM provider_invoices
      WHERE organization_id = $1
      ORDER BY invoice_date DESC
      LIMIT 50
      `,
      [session.orgId]
    );

    // 2. Fetch gateway-calculated spend for current month
    const { rows: dbRows } = await pool.query<{ provider: string; spend: string }>(
      `
      SELECT provider,
             SUM(cost_usd)::text AS spend
      FROM   transactions
      WHERE  status          = 'success'
        AND  organization_id = $1
        AND  created_at     >= date_trunc('month', now())
      GROUP  BY provider
      `,
      [session.orgId]
    );

    const calculated: Record<string, number> = {};
    for (const r of dbRows) {
      calculated[r.provider.toLowerCase()] = parseFloat(r.spend);
    }

    const invoices: InvoiceLine[] = invRows.map((r) => ({
      provider: r.provider,
      invoiceNumber: r.invoice_number ?? undefined,
      billedUsd: parseFloat(r.billed_amount_usd),
      date: r.invoice_date,
      period: r.invoice_date.slice(0, 7),
      currency: "USD",
    }));

    // If invoices exist, reconcile against them; otherwise reconcile actual spend
    const targetInvoices: InvoiceLine[] = invoices;

    const seen = new Set<string>();
    const reconRows: ReconciliationRow[] = targetInvoices.map((inv) => {
      const key = inv.provider.toLowerCase();
      seen.add(key);
      const calc = calculated[key] ?? 0;
      const variance = inv.billedUsd - calc;
      const variancePct = calc === 0 ? (inv.billedUsd > 0 ? 100 : 0) : (variance / calc) * 100;

      let status: ReconciliationStatus = "matched";
      if (Math.abs(variancePct) <= 1.0) status = "matched";
      else if (variance > 0) status = "over-billed";
      else status = "under-billed";

      return {
        provider: PROVIDER_LABELS[key] ?? key,
        calculatedUsd: Math.round(calc * 100) / 100,
        billedUsd: Math.round(inv.billedUsd * 100) / 100,
        varianceUsd: parseFloat(variance.toFixed(2)),
        variancePct: parseFloat(variancePct.toFixed(2)),
        status,
      };
    });

    for (const [key, calc] of Object.entries(calculated)) {
      if (!seen.has(key)) {
        reconRows.push({
          provider: PROVIDER_LABELS[key] ?? key,
          calculatedUsd: Math.round(calc * 100) / 100,
          billedUsd: 0,
          varianceUsd: -parseFloat(calc.toFixed(2)),
          variancePct: -100,
          status: "missing",
        });
      }
    }

    return NextResponse.json({ rows: reconRows, invoices: invRows });
  } catch (err: any) {
    console.error("[/api/reconciliation] GET error:", err.message);
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return unauthorizedResponse();

  try {
    const body = (await req.json()) as { invoices?: InvoiceLine[]; persist?: boolean };
    const invoices = body.invoices ?? [];

    const dbUp = await isDbAvailable();
    if (!dbUp) return dbUnavailable();

    const pool = getPool();

    // Query actual monthly spend per provider from Postgres scoped to tenant
    const { rows: dbRows } = await pool.query<{ provider: string; spend: string }>(
      `
      SELECT provider,
             SUM(cost_usd)::text AS spend
      FROM   transactions
      WHERE  status          = 'success'
        AND  organization_id = $1
        AND  created_at     >= date_trunc('month', now())
      GROUP  BY provider
      `,
      [session.orgId]
    );

    const calculated: Record<string, number> = {};
    for (const r of dbRows) {
      calculated[r.provider.toLowerCase()] = parseFloat(r.spend);
    }

    const seen = new Set<string>();

    const reconRows: ReconciliationRow[] = invoices.map((inv) => {
      const key = inv.provider.toLowerCase();
      seen.add(key);
      const calc = calculated[key] ?? 0;
      const variance = inv.billedUsd - calc;
      const variancePct = calc === 0 ? (inv.billedUsd > 0 ? 100 : 0) : (variance / calc) * 100;

      let status: ReconciliationStatus = "matched";
      if (Math.abs(variancePct) <= 1.5) status = "matched";
      else if (variance > 0) status = "over-billed";
      else status = "under-billed";

      return {
        provider: PROVIDER_LABELS[key] ?? key,
        calculatedUsd: Math.round(calc * 100) / 100,
        billedUsd: Math.round(inv.billedUsd * 100) / 100,
        varianceUsd: parseFloat(variance.toFixed(2)),
        variancePct: parseFloat(variancePct.toFixed(2)),
        status,
      };
    });

    for (const [key, calc] of Object.entries(calculated)) {
      if (!seen.has(key)) {
        reconRows.push({
          provider: PROVIDER_LABELS[key] ?? key,
          calculatedUsd: Math.round(calc * 100) / 100,
          billedUsd: 0,
          varianceUsd: -parseFloat(calc.toFixed(2)),
          variancePct: -100,
          status: "missing",
        });
      }
    }

    // Optionally persist parsed invoice lines into provider_invoices
    if (body.persist && invoices.length > 0) {
      for (const inv of invoices) {
        const key = inv.provider.toLowerCase();
        const calc = calculated[key] ?? 0;
        const status = Math.abs(inv.billedUsd - calc) <= 0.05 * calc ? "reconciled" : "disputed";
        const invDate = inv.date || new Date().toISOString().slice(0, 10);

        await pool.query(
          `
          INSERT INTO provider_invoices (
            organization_id,
            provider,
            invoice_number,
            invoice_date,
            period_start,
            period_end,
            billed_amount_usd,
            net_amount_usd,
            status,
            metadata
          ) VALUES (
            $1, $2, $3, $4, date_trunc('month', $4::date), date_trunc('month', $4::date) + interval '1 month - 1 day',
            $5, $5, $6, $7
          )
          ON CONFLICT (organization_id, provider, invoice_number)
          DO UPDATE SET
            billed_amount_usd = EXCLUDED.billed_amount_usd,
            net_amount_usd    = EXCLUDED.net_amount_usd,
            status            = EXCLUDED.status
          `,
          [
            session.orgId,
            key,
            inv.invoiceNumber || `INV-${key.toUpperCase()}-${invDate}`,
            invDate,
            inv.billedUsd,
            status,
            JSON.stringify({ calculated_usd: calc, matched_at: new Date().toISOString() }),
          ]
        ).catch((e) => console.warn("[/api/reconciliation] Failed to persist invoice line:", e.message));
      }
    }

    return NextResponse.json({ rows: reconRows });
  } catch (err: any) {
    console.error("[/api/reconciliation] POST error:", err.message);
    return NextResponse.json({ error: "Invalid request or database error" }, { status: 500 });
  }
}
