import type { ReactNode } from "react";

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
  const accentMap = {
    brand: "text-brand-600",
    emerald: "text-emerald-600",
    amber: "text-amber-600",
    red: "text-red-600",
  } as const;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-500">{label}</span>
        {icon && <span className={accentMap[accent]}>{icon}</span>}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}
