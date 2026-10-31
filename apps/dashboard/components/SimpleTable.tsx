import type { ReactNode } from "react";

export type Column<T> = { header: string; cell: (row: T) => ReactNode; width?: number | string };

/** Plain, non-sortable table in the dash-shell style, for server-ordered lists (history, audit). */
export function SimpleTable<T>({
  columns,
  rows,
  rowKey,
  empty = "Nothing here yet.",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: string;
}) {
  if (rows.length === 0) {
    return <div className="mono" style={{ color: "var(--fg-3)", fontSize: 13, padding: "8px 0" }}>{empty}</div>;
  }
  return (
    <div className="data-table-wrap">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--line-soft)" }}>
            {columns.map((c) => (
              <th
                key={c.header}
                className="mono"
                style={{
                  padding: "8px 14px", textAlign: "left", fontWeight: 400, color: "var(--fg-4)",
                  fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.04em", width: c.width,
                }}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} style={{ borderBottom: "1px solid var(--line-soft)" }}>
              {columns.map((c) => (
                <td key={c.header} style={{ padding: "9px 14px", color: "var(--fg-2)", verticalAlign: "top" }}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
export const fmtUsd = (v?: string | number | null) => (v === null || v === undefined ? "—" : `$${Number(v).toFixed(4)}`);
