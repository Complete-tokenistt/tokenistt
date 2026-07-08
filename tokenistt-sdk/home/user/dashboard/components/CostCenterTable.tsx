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
          <div className="font-medium text-slate-800">{row.original.name}</div>
          <div className="text-xs text-slate-400">{row.original.code}</div>
        </div>
      ),
    },
    {
      accessorKey: "owner",
      header: "Owner",
      cell: ({ getValue }) => (
        <span className="text-slate-600">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "spendUsd",
      header: "Spend (MTD)",
      cell: ({ getValue }) => (
        <span className="font-medium tabular-nums">
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
            className={`tabular-nums font-medium ${
              v >= 0 ? "text-emerald-600" : "text-red-600"
            }`}
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
        <span className="tabular-nums text-slate-500">
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
