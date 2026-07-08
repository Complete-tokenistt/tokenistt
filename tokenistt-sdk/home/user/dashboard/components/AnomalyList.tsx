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
      <p className="py-6 text-center text-sm text-slate-400">
        No anomalies detected.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-slate-100">
      {anomalies.map((a) => (
        <li key={a.id} className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{a.actor}</span>
              <Badge tone={a.severity}>{a.severity}</Badge>
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              {a.costCenter} · {fmtDate(a.detectedAt)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm font-semibold text-red-600">
              {fmtPct(a.ratio, false)}×
            </div>
            <div className="text-xs text-slate-400">
              {fmtUsd(a.spend24hUsd)} / 24h
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
