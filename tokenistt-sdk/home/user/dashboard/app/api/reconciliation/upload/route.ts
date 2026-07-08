import { NextResponse } from "next/server";
import { parseCsv, extractInvoicesFromText } from "@/lib/invoice-parse";
import type { InvoiceLine } from "@/lib/types";

export const runtime = "nodejs";

// POST /api/reconciliation/upload  (multipart/form-data, field "file")
// Parses an uploaded vendor invoice (.csv or .pdf) into InvoiceLine[] that can
// then be POSTed to /api/reconciliation for variance calculation.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }

    const name = file.name.toLowerCase();
    let invoices: InvoiceLine[] = [];

    if (name.endsWith(".csv")) {
      invoices = parseCsv(await file.text());
    } else if (name.endsWith(".pdf")) {
      const buf = Buffer.from(await file.arrayBuffer());
      // pdf-parse is loaded lazily so the route works even if no PDFs are used.
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
      const parsed = await pdfParse(buf);
      invoices = extractInvoicesFromText(parsed.text);
    } else {
      return NextResponse.json(
        { error: "Unsupported file type. Use .csv or .pdf" },
        { status: 415 },
      );
    }

    return NextResponse.json({ invoices });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to parse file." },
      { status: 500 },
    );
  }
}
