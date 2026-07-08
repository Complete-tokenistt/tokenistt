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
};

export default function ShadowAiTable({ data }: { data: ShadowAiEvent[] }) {
  const [rows, setRows] = useState<ShadowAiEvent[]>(data);

  const setStatus = (id: string, status: ShadowAiStatus) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));

  const columns: ColumnDef<ShadowAiEvent, unknown>[] = [
    {
      accessorKey: "vendor",
      header: "Vendor",
      cell: ({ getValue }) => (
        <span className="font-medium text-slate-800">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "source",
      header: "Detected via",
      cell: ({ getValue }) => SOURCE_LABEL[getValue<ShadowAiEvent["source"]>()],
    },
    {
      accessorKey: "actor",
      header: "Actor",
      cell: ({ getValue }) => {
        const v = getValue<string>();
        return <span className="text-slate-600">{v === "unknown" ? "—" : v}</span>;
      },
    },
    {
      accessorKey: "amountUsd",
      header: "Amount",
      cell: ({ getValue }) => {
        const v = getValue<number>();
        return (
          <span className="tabular-nums text-slate-700">
            {v > 0 ? fmtUsd(v) : "usage"}
          </span>
        );
      },
    },
    {
      accessorKey: "detectedAt",
      header: "Detected",
      cell: ({ getValue }) => (
        <span className="text-xs text-slate-400">{fmtDate(getValue<string>())}</span>
      ),
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
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setStatus(row.original.id, "acknowledged")}
            className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Acknowledge
          </button>
          <button
            onClick={() => setStatus(row.original.id, "approved")}
            className="rounded-md bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700"
          >
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
