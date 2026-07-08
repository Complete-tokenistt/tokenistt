import type { ReactNode } from "react";

const ACCENT: Record<string, string> = {
  brand: "var(--violet)",
  emerald: "var(--green)",
  amber: "var(--amber)",
  red: "var(--red)",
};

export default function StatCard({
  label,
  value,
  sub,
  accent = "brand",
  icon,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  accent?: "brand" | "emerald" | "amber" | "red";
  icon?: ReactNode;
}) {
  const color = ACCENT[accent];
  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
        {icon && <span style={{ color }}>{icon}</span>}
      </div>
      <div className="mono" style={{ marginTop: 8, fontSize: 22, color: "var(--fg)", letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div className="mono" style={{ marginTop: 4, fontSize: 11, color: "var(--fg-3)" }}>{sub}</div>}
    </div>
  );
}
