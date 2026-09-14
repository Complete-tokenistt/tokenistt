"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import type { ShadowAiEvent, ShadowAiStatus } from "@/lib/types";
import { fmtUsd, fmtDate } from "@/lib/format";
import Badge from "./Badge";
import { DataTable } from "./DataTable";

const SOURCE_LABEL: Record<ShadowAiEvent["source"], string> = {
  "card-transaction": "Corporate card",
  "browser-extension": "Browser extension",
  "expense-report": "Expense report",
  "slack-integration": "Slack integration",
  "gateway-detection": "Gateway detection",
};

export default function ShadowAiTable({ data }: { data: ShadowAiEvent[] }) {
  const [rows, setRows] = useState<ShadowAiEvent[]>(data);

  const setStatus = (id: string, status: ShadowAiStatus) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));

  const columns: ColumnDef<ShadowAiEvent, unknown>[] = [
    {
      accessorKey: "vendor",
      header: "Vendor",
      cell: ({ getValue }) => <span style={{ fontSize: 14, color: "var(--fg)" }}>{getValue<string>()}</span>,
    },
    {
      accessorKey: "source",
      header: "Detected via",
      cell: ({ getValue }) => <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>{SOURCE_LABEL[getValue<ShadowAiEvent["source"]>()]}</span>,
    },
    {
      accessorKey: "actor",
      header: "Actor",
      cell: ({ getValue }) => {
        const v = getValue<string>();
        return <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>{v === "unknown" ? "—" : v}</span>;
      },
    },
    {
      accessorKey: "amountUsd",
      header: "Amount",
      cell: ({ getValue }) => {
        const v = getValue<number>();
        return <span className="mono" style={{ fontSize: 13, color: "var(--fg-1)" }}>{v > 0 ? fmtUsd(v) : "usage"}</span>;
      },
    },
    {
      accessorKey: "detectedAt",
      header: "Detected",
      cell: ({ getValue }) => <span className="mono" style={{ fontSize: 12, color: "var(--fg-4)" }}>{fmtDate(getValue<string>())}</span>,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <Badge tone={row.original.status}>{row.original.status}</Badge>,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStatus(row.original.id, "acknowledged")}>
            Acknowledge
          </button>
          <button type="button" className="btn btn-violet btn-sm" onClick={() => setStatus(row.original.id, "approved")}>
            Approve
          </button>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={rows}
      initialSorting={[{ id: "detectedAt", desc: true }]}
    />
  );
}
