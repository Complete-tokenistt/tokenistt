"use client";

import { type ColumnDef } from "@tanstack/react-table";
import type { ReconciliationRow } from "@/lib/types";
import { fmtUsd, fmtPct } from "@/lib/format";
import Badge from "./Badge";
import { DataTable } from "./DataTable";

export default function ReconciliationTable({
  rows,
}: {
  rows: ReconciliationRow[];
}) {
  const totalCalc = rows.reduce((s, r) => s + r.calculatedUsd, 0);
  const totalBilled = rows.reduce((s, r) => s + r.billedUsd, 0);
  const net = totalBilled - totalCalc;

  const columns: ColumnDef<ReconciliationRow, unknown>[] = [
    {
      accessorKey: "provider",
      header: "Provider",
      cell: ({ getValue }) => (
        <span className="font-medium text-slate-800">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "calculatedUsd",
      header: "Calculated (ledger)",
      cell: ({ getValue }) => (
        <span className="tabular-nums text-slate-600">
          {fmtUsd(getValue<number>(), 2)}
        </span>
      ),
    },
    {
      accessorKey: "billedUsd",
      header: "Billed (invoice)",
      cell: ({ getValue }) => (
        <span className="tabular-nums text-slate-600">
          {fmtUsd(getValue<number>(), 2)}
        </span>
      ),
    },
    {
      accessorKey: "varianceUsd",
      header: "Variance",
      cell: ({ getValue }) => {
        const v = getValue<number>();
        return (
          <span
            className={`tabular-nums font-medium ${
              Math.abs(v) < 0.005
                ? "text-slate-500"
                : v > 0
                  ? "text-amber-600"
                  : "text-red-600"
            }`}
          >
            {v > 0 ? "+" : ""}
            {fmtUsd(v, 2)}
          </span>
        );
      },
    },
    {
      accessorKey: "variancePct",
      header: "Δ%",
      cell: ({ getValue }) => {
        const v = getValue<number>();
        return (
          <span className="tabular-nums text-slate-500">
            {v > 0 ? "+" : ""}
            {v.toFixed(1)}%
          </span>
        );
      },
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ getValue }) => <Badge tone={getValue<string>()}>{getValue<string>()}</Badge>,
    },
  ];

  return (
    <div>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="text-xs text-slate-400">Total calculated</div>
          <div className="text-lg font-semibold tabular-nums">
            {fmtUsd(totalCalc, 2)}
          </div>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="text-xs text-slate-400">Total billed</div>
          <div className="text-lg font-semibold tabular-nums">
            {fmtUsd(totalBilled, 2)}
          </div>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="text-xs text-slate-400">Net variance</div>
          <div
            className={`text-lg font-semibold tabular-nums ${
              Math.abs(net) < 0.005
                ? "text-slate-700"
                : net > 0
                  ? "text-amber-600"
                  : "text-red-600"
            }`}
          >
            {net > 0 ? "+" : ""}
            {fmtUsd(net, 2)} ({fmtPct((net / totalCalc) * 100)})
          </div>
        </div>
      </div>

      <DataTable columns={columns} data={rows} />
    </div>
  );
}
