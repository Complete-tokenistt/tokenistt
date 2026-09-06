import ProgressBar from "./ProgressBar";
import { fmtUsd } from "@/lib/format";

// Used / budget progress bar with a "$45 / $50" label.
export default function BudgetBar({
  used,
  budget,
  showValues = true,
}: {
  used: number;
  budget: number;
  showValues?: boolean;
}) {
  const pct = budget > 0 ? (used / budget) * 100 : 0;
  const tone = pct >= 100 ? "red" : pct >= 90 ? "amber" : "emerald";

  return (
    <div className="w-full max-w-[220px]">
      {showValues && (
        <div
          className="mb-1 flex items-center justify-between text-xs mono"
          style={{ color: "var(--fg-3)" }}
        >
          <span className="tabular-nums">
            {fmtUsd(used)} / {fmtUsd(budget)}
          </span>
          <span className="tabular-nums font-medium" style={{ color: "var(--fg-2)" }}>
            {pct.toFixed(0)}%
          </span>
        </div>
      )}
      <ProgressBar valuePct={pct} tone={tone} />
    </div>
  );
}
