"use client";

import { type ColumnDef } from "@tanstack/react-table";
import type { TeamMember } from "@/lib/types";
import { fmtUsd, fmtNumber, MODEL_COLORS } from "@/lib/format";
import Badge from "./Badge";
import BudgetBar from "./BudgetBar";
import { DataTable } from "./DataTable";

// Tiny per-member model-mix bar: expensive (warm) vs cheap (cool) at a glance.
function MiniModelBar({ models }: { models: TeamMember["models"] }) {
  const total = models.reduce((s, m) => s + m.spendUsd, 0) || 1;
  return (
    <div
      className="flex h-2 w-32 overflow-hidden rounded-full"
      style={{ background: "var(--bg-3)" }}
      title={models
        .map((m) => `${m.label}: ${fmtUsd(m.spendUsd)}`)
        .join("\n")}
    >
      {models.map((m) => (
        <div
          key={m.model}
          style={{
            width: `${(m.spendUsd / total) * 100}%`,
            background: MODEL_COLORS[m.model] ?? "#94a3b8",
          }}
        />
      ))}
    </div>
  );
}

export default function TeamMemberTable({ data }: { data: TeamMember[] }) {
  const columns: ColumnDef<TeamMember, unknown>[] = [
    {
      accessorKey: "name",
      header: "Member",
      cell: ({ row }) => (
        <div>
          <div className="font-medium" style={{ color: "var(--fg)" }}>{row.original.name}</div>
          <div className="text-xs mono" style={{ color: "var(--fg-4)" }}>{row.original.email}</div>
        </div>
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
      id: "budget",
      header: "Budget",
      cell: ({ row }) => (
        <BudgetBar used={row.original.spendUsd} budget={row.original.budgetUsd} />
      ),
    },
    {
      accessorKey: "calls",
      header: "Calls",
      cell: ({ getValue }) => (
        <span className="mono tabular-nums" style={{ color: "var(--fg-3)" }}>
          {fmtNumber(getValue<number>())}
        </span>
      ),
    },
    {
      id: "models",
      header: "Model mix",
      cell: ({ row }) => <MiniModelBar models={row.original.models} />,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ getValue }) => (
        <Badge tone={getValue<string>()}>{getValue<string>()}</Badge>
      ),
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
