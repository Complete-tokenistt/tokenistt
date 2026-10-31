import type { AnomalyAlert } from "@/lib/types";
import { fmtUsd, fmtDate, fmtPct } from "@/lib/format";
import Badge from "./Badge";

export default function AnomalyList({
  anomalies,
}: {
  anomalies: AnomalyAlert[];
}) {
  if (anomalies.length === 0) {
    return (
      <p className="py-6 text-center text-sm mono" style={{ color: "var(--fg-4)" }}>
        No anomalies detected.
      </p>
    );
  }
  return (
    <ul style={{ borderTop: "1px solid var(--line-soft)" }}>
      {anomalies.map((a) => (
        <li
          key={a.id}
          className="flex items-center justify-between gap-3 py-3"
          style={{ borderBottom: "1px solid var(--line-soft)" }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium" style={{ color: "var(--fg)" }}>
                {a.actor}
              </span>
              <Badge tone={a.severity}>{a.severity}</Badge>
            </div>
            <div className="mt-0.5 text-xs mono" style={{ color: "var(--fg-4)" }}>
              {a.costCenter} · {fmtDate(a.detectedAt)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm font-semibold mono tabular-nums" style={{ color: "var(--red)" }}>
              {fmtPct(a.ratio, false)}×
            </div>
            <div className="text-xs mono tabular-nums" style={{ color: "var(--fg-4)" }}>
              {fmtUsd(a.spend24hUsd)} / 24h
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
