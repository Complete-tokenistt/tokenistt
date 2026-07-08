import { NextResponse } from "next/server";
import { reconcile } from "@/lib/mock-data";
import type { InvoiceLine } from "@/lib/types";

// POST /api/reconciliation
// Body: { invoices: InvoiceLine[] }
// Returns reconciled rows: ledger-calculated cost vs uploaded invoice total.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { invoices?: InvoiceLine[] };
    const invoices = body.invoices ?? [];
    const rows = reconcile(invoices);
    return NextResponse.json({ rows });
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }
}
