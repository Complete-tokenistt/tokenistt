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
      ? "var(--red)"
      : tone === "amber"
        ? "var(--amber)"
        : tone === "emerald"
          ? "var(--green)"
          : "var(--violet)";
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full"
      style={{ background: "var(--bg-3)" }}
    >
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${clamped}%`, background: color }}
      />
    </div>
  );
}
