"use client";

import { useRef, useState } from "react";
import type { InvoiceLine, ReconciliationRow } from "@/lib/types";
import { parseCsv } from "@/lib/invoice-parse";

const SAMPLE_CSV = `provider,period,billedUsd,currency
openai,2026-07,12450,USD
anthropic,2026-07,6150,USD
bedrock,2026-07,2095,USD
google,2026-07,560,USD
mistral,2026-07,180,USD`;

export default function InvoiceUploader({
  onReconciled,
}: {
  onReconciled: (rows: ReconciliationRow[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function sendForReconciliation(invoices: InvoiceLine[]) {
    const res = await fetch("/api/reconciliation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoices }),
    });
    if (!res.ok) throw new Error("Reconciliation failed");
    const data = (await res.json()) as { rows: ReconciliationRow[] };
    onReconciled(data.rows);
  }

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    setFileName(file.name);
    try {
      const lower = file.name.toLowerCase();
      let invoices: InvoiceLine[];

      if (lower.endsWith(".csv")) {
        const text = await file.text();
        invoices = parseCsv(text);
        if (invoices.length === 0) throw new Error("No rows found in CSV.");
      } else if (lower.endsWith(".pdf")) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/reconciliation/upload", {
          method: "POST",
          body: fd,
        });
        if (!res.ok) throw new Error("Could not parse PDF invoice.");
        const data = (await res.json()) as { invoices: InvoiceLine[] };
        invoices = data.invoices;
        if (invoices.length === 0)
          throw new Error("No invoice line items detected in PDF.");
      } else {
        throw new Error("Unsupported file type. Use .csv or .pdf");
      }

      await sendForReconciliation(invoices);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {busy ? "Processing…" : "Upload invoice"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        <span className="text-xs text-slate-400">
          CSV or PDF · OpenAI / Anthropic / Bedrock / Google / Mistral
        </span>
        <a
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`}
          download="sample-invoices.csv"
          className="ml-auto text-xs font-medium text-brand-600 hover:underline"
        >
          Download sample CSV
        </a>
      </div>

      {fileName && (
        <p className="mt-2 text-xs text-slate-500">
          Loaded: <span className="font-medium">{fileName}</span>
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
