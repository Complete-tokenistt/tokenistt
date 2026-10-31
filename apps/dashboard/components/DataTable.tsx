"use client";

import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useState } from "react";

export function DataTable<T>({
  columns,
  data,
  initialSorting = [],
  emptyMessage = "No rows.",
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  initialSorting?: SortingState;
  emptyMessage?: string;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="data-table-wrap">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} style={{ borderBottom: "1px solid var(--line-soft)" }}>
              {hg.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className="mono"
                    style={{
                      padding: "8px 14px", textAlign: "left", fontWeight: 400,
                      color: "var(--fg-4)", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em",
                      cursor: canSort ? "pointer" : undefined, userSelect: canSort ? "none" : undefined,
                    }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {canSort && <span style={{ color: "var(--fg-4)" }}>{sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}</span>}
                    </span>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: "24px 18px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            table.getRowModel().rows.map((row, i) => (
              <tr key={row.id} style={{ borderBottom: i < table.getRowModel().rows.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} style={{ padding: "12px 14px", verticalAlign: "middle", color: "var(--fg-1)" }}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
