"use client";

import { useState } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { Sparkline } from "@/components/Sparkline";
import { ConfidenceBadge, FreshnessBadge } from "@/components/StatusBadges";
import { UNIT_ECONOMICS_METRICS, CONNECTED_DATA_SOURCES } from "@/lib/dashboard-mock-data";

const EMPTY_METRIC = { label: "", feature: "", value: "", unit: "$" };

type Metric = (typeof UNIT_ECONOMICS_METRICS)[number];

export default function UnitEconomicsPage() {
  const { notify } = useDashboard();
  const [metrics, setMetrics] = useState<Metric[]>(UNIT_ECONOMICS_METRICS);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_METRIC);

  function defineMetric(e: React.FormEvent) {
    e.preventDefault();
    if (!form.label.trim() || !form.feature.trim() || !form.value) return;
    const id = metrics.length ? Math.max(...metrics.map((m) => m.id)) + 1 : 1;
    const value = Number(form.value);
    setMetrics((ms) => [...ms, {
      id, label: form.label.trim(), feature: form.feature.trim(), value, unit: form.unit,
      confidence: "estimated", dataSource: "manually defined — no live data source yet", freshness: "stale",
      trend: [value * 1.3, value * 1.22, value * 1.14, value * 1.08, value * 1.03, value],
    }]);
    notify(`Metric "${form.label.trim()}" defined`);
    setForm(EMPTY_METRIC);
    setFormOpen(false);
  }

  return (
    <div>
      <div className="card" style={{ padding: 18, marginBottom: 24 }}>
        <div className="mono dash-section-label" style={{ marginBottom: 12 }}>CONNECTED DATA SOURCES</div>
        <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          {CONNECTED_DATA_SOURCES.map((s) => (
            <div key={s.id} style={{ padding: "10px 12px", border: "1px solid var(--line-soft)", borderRadius: 6 }}>
              <div style={{ fontSize: 13.5, color: "var(--fg-1)", marginBottom: 6 }}>{s.name}</div>
              <FreshnessBadge status={s.status === "not connected" ? "stale" : s.status} lastSync={s.status === "not connected" ? null : s.lastSync} />
            </div>
          ))}
        </div>
        <p style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 12, lineHeight: 1.5 }}>
          These numbers are only as good as the data connected here. Metrics below inherit &quot;measured&quot; confidence only when every source feeding them is live.
        </p>
      </div>

      <div className="dash-section-head">
        <div>
          <div className="mono dash-section-label">COST PER OUTCOME · {metrics.length}</div>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Configurable per feature — trend over the last 6 periods</div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFormOpen((v) => !v)}>{formOpen ? "Close" : "+ Define metric"}</button>
      </div>

      {formOpen && (
        <form onSubmit={defineMetric} className="card" style={{ padding: 16, marginBottom: 16, background: "oklch(0.420 0.150 295 / 0.06)" }}>
          <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1.3fr 1.2fr 0.7fr 0.6fr auto", gap: 10, alignItems: "end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>METRIC LABEL</span>
              <input className="mono dash-input" required value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="Cost per signup" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>FEATURE</span>
              <input className="mono dash-input" required value={form.feature} onChange={(e) => setForm((f) => ({ ...f, feature: e.target.value }))} placeholder="growth-agents" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>VALUE</span>
              <input className="mono dash-input" type="number" step="0.01" min="0" required value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} placeholder="0.42" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>UNIT</span>
              <select className="mono dash-select" value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}>
                <option value="$">$</option>
                <option value="tk">tk</option>
              </select>
            </label>
            <button type="submit" className="btn btn-violet btn-sm">Define</button>
          </div>
        </form>
      )}

      <div className="integration-grid">
        {metrics.map((m) => (
          <div key={m.id} className="card" style={{ padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div>
                <div style={{ fontSize: 14.5, color: "var(--fg)" }}>{m.label}</div>
                <div className="mono" style={{ fontSize: 12, color: "var(--fg-4)", marginTop: 3 }}>{m.feature}</div>
              </div>
              <ConfidenceBadge level={m.confidence} source={m.dataSource} />
            </div>
            <div className="mono" style={{ fontSize: 28, color: "var(--fg)", marginTop: 14, letterSpacing: "-0.02em" }}>
              {m.unit}{m.value.toFixed(2)}
            </div>
            <div style={{ marginTop: 10 }}>
              <Sparkline data={m.trend} width={220} height={40} stroke={m.confidence === "measured" ? "var(--violet)" : "var(--amber)"} showFill={false} pad={2} strokeWidth={1.3} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)" }}>{m.dataSource}</span>
              <FreshnessBadge status={m.freshness} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
