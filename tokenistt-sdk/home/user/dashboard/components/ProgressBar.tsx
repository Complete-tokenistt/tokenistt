export default function ProgressBar({
  valuePct,
  tone = "brand",
}: {
  valuePct: number; // 0..100+ (can exceed 100)
  tone?: "brand" | "emerald" | "amber" | "red";
}) {
  const clamped = Math.max(0, Math.min(100, valuePct));
  const color =
    tone === "red"
      ? "bg-red-500"
      : tone === "amber"
        ? "bg-amber-500"
        : tone === "emerald"
          ? "bg-emerald-500"
          : "bg-brand-600";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div
        className={`h-full rounded-full ${color} transition-all`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
