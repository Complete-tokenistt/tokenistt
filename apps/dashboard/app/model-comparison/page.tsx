"use client";

import { useMemo, useState } from "react";
import { StateNote, useGateway } from "@/lib/useGateway";
import { fmtUsd } from "@/lib/format";

type Row = {
  provider: string; model: string; requests: number;
  avg_cost_usd: number | null; avg_latency_ms: number | null; error_rate: number | null;
  input_per_1m: number | null; output_per_1m: number | null;
};

const usd = (n: number | null) => (n == null ? "—" : fmtUsd(n, 4));
const keyOf = (r: Row) => `${r.provider}:${r.model}`;

export default function ModelComparisonPage() {
  const { data, error, loading } = useGateway<Row[]>("models");
  const [onlyUsed, setOnlyUsed] = useState(false);
  const [inTok, setInTok] = useState(1000);
  const [outTok, setOutTok] = useState(300);

  const rows = useMemo(() => {
    const list = (data ?? []).filter((r) => !onlyUsed || r.requests > 0);
    return list
      .map((r) => ({
        ...r,
        est: r.input_per_1m != null && r.output_per_1m != null ? (inTok * r.input_per_1m + outTok * r.output_per_1m) / 1_000_000 : null,
      }))
      .sort((a, b) => (a.est ?? Infinity) - (b.est ?? Infinity));
  }, [data, onlyUsed, inTok, outTok]);

  const cheapest = rows.find((r) => r.est != null)?.est ?? null;

  return (
    <div>
      <div className="dash-range-bar" style={{ gap: 16, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>input tokens</span>
          <input className="mono dash-input" type="number" min={0} style={{ width: 90 }} value={inTok} onChange={(e) => setInTok(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>output tokens</span>
          <input className="mono dash-input" type="number" min={0} style={{ width: 90 }} value={outTok} onChange={(e) => setOutTok(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} />
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>only models used in the last 30 days</span>
        </label>
      </div>

      <StateNote loading={loading} error={error} empty={!loading && !error && rows.length === 0 ? "No models to show yet." : undefined} />

      {rows.length > 0 && (
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line-soft)", background: "var(--bg-2)" }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>
              price catalog + your observed traffic (30d) · estimate is for a {inTok}-in / {outTok}-out request · quality is not measured here
            </span>
          </div>
          <div className="data-table-wrap">
            <div style={{ minWidth: 760 }}>
              <div className="mono" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr 1fr 1fr 0.8fr", padding: "8px 18px", borderBottom: "1px solid var(--line-soft)", fontSize: 11.5, color: "var(--fg-4)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <span>Model</span><span>Est. cost / req</span><span>$ / 1M in</span><span>$ / 1M out</span><span>Observed avg cost</span><span>Avg latency</span><span>Errors</span>
              </div>
              {rows.map((r, i) => (
                <div key={keyOf(r)} style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr 1fr 1fr 0.8fr", padding: "12px 18px", borderBottom: i < rows.length - 1 ? "1px solid var(--line-soft)" : "none", alignItems: "center" }}>
                  <div>
                    <span className="mono" style={{ fontSize: 13.5, color: "var(--fg)" }}>{r.model}</span>
                    <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)", marginTop: 2 }}>{r.provider}{r.requests > 0 ? ` · ${r.requests.toLocaleString()} req` : ""}</div>
                  </div>
                  <span className="mono" style={{ fontSize: 13, color: r.est != null && r.est === cheapest ? "var(--green)" : "var(--fg-2)" }}>{usd(r.est)}</span>
                  <span className="mono" style={{ fontSize: 13, color: "var(--fg-2)" }}>{r.input_per_1m != null ? `$${r.input_per_1m}` : "—"}</span>
                  <span className="mono" style={{ fontSize: 13, color: "var(--fg-2)" }}>{r.output_per_1m != null ? `$${r.output_per_1m}` : "—"}</span>
                  <span className="mono" style={{ fontSize: 13, color: "var(--fg-2)" }}>{usd(r.avg_cost_usd)}</span>
                  <span className="mono" style={{ fontSize: 13, color: "var(--fg-2)" }}>{r.avg_latency_ms != null ? `${Math.round(r.avg_latency_ms)} ms` : "—"}</span>
                  <span className="mono" style={{ fontSize: 13, color: (r.error_rate ?? 0) > 0.05 ? "var(--red)" : "var(--fg-2)" }}>{r.error_rate != null ? `${(r.error_rate * 100).toFixed(1)}%` : "—"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
