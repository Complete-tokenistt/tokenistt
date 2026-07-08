import type { ReactNode } from "react";

export function Kpi({ label, value, sub, accent = false, style }: { label: string; value: ReactNode; sub?: string; accent?: boolean; style?: React.CSSProperties }) {
  return (
    <div style={{ padding: "14px 16px", borderRight: "1px solid var(--line-soft)", borderBottom: "1px solid var(--line-soft)", ...style }}>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>{label}</div>
      <div className="mono" style={{ fontSize: 22, color: accent ? "var(--violet)" : "var(--fg)", letterSpacing: "-0.02em", lineHeight: 1 }}>{value}</div>
      {sub && <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}
