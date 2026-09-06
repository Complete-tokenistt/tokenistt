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
        <span className="font-medium" style={{ color: "var(--fg)" }}>
          {getValue<string>()}
        </span>
      ),
    },
    {
      accessorKey: "calculatedUsd",
      header: "Calculated (ledger)",
      cell: ({ getValue }) => (
        <span className="mono tabular-nums" style={{ color: "var(--fg-2)" }}>
          {fmtUsd(getValue<number>(), 2)}
        </span>
      ),
    },
    {
      accessorKey: "billedUsd",
      header: "Billed (invoice)",
      cell: ({ getValue }) => (
        <span className="mono tabular-nums" style={{ color: "var(--fg-2)" }}>
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
            className="mono tabular-nums font-medium"
            style={{
              color:
                Math.abs(v) < 0.005
                  ? "var(--fg-3)"
                  : v > 0
                    ? "var(--amber)"
                    : "var(--red)",
            }}
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
          <span className="mono tabular-nums" style={{ color: "var(--fg-3)" }}>
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
        <div className="card p-3.5" style={{ background: "var(--bg-2)", borderColor: "var(--line-soft)" }}>
          <div className="text-xs mono uppercase tracking-wider" style={{ color: "var(--fg-4)" }}>
            Total calculated
          </div>
          <div className="text-lg font-semibold mono tabular-nums mt-1" style={{ color: "var(--fg)" }}>
            {fmtUsd(totalCalc, 2)}
          </div>
        </div>
        <div className="card p-3.5" style={{ background: "var(--bg-2)", borderColor: "var(--line-soft)" }}>
          <div className="text-xs mono uppercase tracking-wider" style={{ color: "var(--fg-4)" }}>
            Total billed
          </div>
          <div className="text-lg font-semibold mono tabular-nums mt-1" style={{ color: "var(--fg)" }}>
            {fmtUsd(totalBilled, 2)}
          </div>
        </div>
        <div className="card p-3.5" style={{ background: "var(--bg-2)", borderColor: "var(--line-soft)" }}>
          <div className="text-xs mono uppercase tracking-wider" style={{ color: "var(--fg-4)" }}>
            Net variance
          </div>
          <div
            className="text-lg font-semibold mono tabular-nums mt-1"
            style={{
              color:
                Math.abs(net) < 0.005
                  ? "var(--fg-2)"
                  : net > 0
                    ? "var(--amber)"
                    : "var(--red)",
            }}
          >
            {net > 0 ? "+" : ""}
            {fmtUsd(net, 2)} ({fmtPct((net / (totalCalc || 1)) * 100)})
          </div>
        </div>
      </div>

      <DataTable columns={columns} data={rows} />
    </div>
  );
}
