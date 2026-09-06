"use client";

import { type ColumnDef } from "@tanstack/react-table";
import type { CostCenterRow } from "@/lib/types";
import { fmtUsd, fmtPct, fmtNumber } from "@/lib/format";
import Badge from "./Badge";
import { DataTable } from "./DataTable";

export default function CostCenterTable({ data }: { data: CostCenterRow[] }) {
  const columns: ColumnDef<CostCenterRow, unknown>[] = [
    {
      accessorKey: "name",
      header: "Cost Center",
      cell: ({ row }) => (
        <div>
          <div className="font-medium" style={{ color: "var(--fg)" }}>{row.original.name}</div>
          <div className="text-xs mono" style={{ color: "var(--fg-4)" }}>{row.original.code}</div>
        </div>
      ),
    },
    {
      accessorKey: "owner",
      header: "Owner",
      cell: ({ getValue }) => (
        <span style={{ color: "var(--fg-2)" }}>{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "spendUsd",
      header: "Spend (MTD)",
      cell: ({ getValue }) => (
        <span className="font-medium mono tabular-nums" style={{ color: "var(--fg)" }}>
          {fmtUsd(getValue<number>())}
        </span>
      ),
    },
    {
      accessorKey: "momGrowthPct",
      header: "MoM",
      cell: ({ getValue }) => {
        const v = getValue<number>();
        return (
          <span
            className="mono tabular-nums font-medium"
            style={{ color: v >= 0 ? "var(--green)" : "var(--red)" }}
          >
            {fmtPct(v)}
          </span>
        );
      },
    },
    {
      accessorKey: "transactionCount",
      header: "Calls",
      cell: ({ getValue }) => (
        <span className="mono tabular-nums" style={{ color: "var(--fg-3)" }}>
          {fmtNumber(getValue<number>())}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ getValue }) => <Badge tone={getValue<string>()}>{getValue<string>()}</Badge>,
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={data}
      initialSorting={[{ id: "spendUsd", desc: true }]}
    />
  );
}
