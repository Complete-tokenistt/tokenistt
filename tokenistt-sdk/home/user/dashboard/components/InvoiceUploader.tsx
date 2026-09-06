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
    <div
      className="card"
      style={{
        padding: "16px 20px",
        background: "var(--bg-2)",
        border: "1px dashed var(--line)",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="btn btn-violet btn-sm"
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
        <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
          CSV or PDF · OpenAI / Anthropic / Bedrock / Google / Mistral
        </span>
        <a
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`}
          download="sample-invoices.csv"
          className="mono"
          style={{
            marginLeft: "auto",
            fontSize: 12.5,
            color: "var(--violet)",
            textDecoration: "none",
          }}
        >
          Download sample CSV →
        </a>
      </div>

      {fileName && (
        <p className="mono" style={{ marginTop: 10, fontSize: 12, color: "var(--fg-2)" }}>
          Loaded: <span style={{ color: "var(--fg)", fontWeight: 500 }}>{fileName}</span>
        </p>
      )}
      {error && (
        <p className="mono" style={{ marginTop: 10, fontSize: 12, color: "var(--red)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
