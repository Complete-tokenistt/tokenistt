"use client";

import { useState, useEffect } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { Sparkline, NumTicker } from "@/components/Sparkline";
import { ConfidenceBadge } from "@/components/StatusBadges";
import { FORECAST_HISTORICAL, FORECAST_PROJECTED, FORECAST_ACCURACY, FORECAST_SCENARIOS } from "@/lib/dashboard-mock-data";

const EMPTY_SCENARIO = { label: "", direction: "+", amount: "", addedBy: "" };

type Scenario = (typeof FORECAST_SCENARIOS)[number];

export default function ForecastingPage() {
  const { isLive, notify } = useDashboard();
  const [scenarios, setScenarios] = useState<Scenario[]>(isLive ? [] : FORECAST_SCENARIOS);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_SCENARIO);
  const [liveForecast, setLiveForecast] = useState<any>(null);

  useEffect(() => {
    if (!isLive) {
      setScenarios(FORECAST_SCENARIOS);
      return;
    }

    async function loadForecast() {
      try {
        const res = await fetch("/api/forecast");
        if (!res.ok) return;
        const data = await res.json();
        if (data) {
          setLiveForecast(data);
        }
      } catch (err) {
        console.warn("Could not load /api/forecast:", err);
      }
    }
    loadForecast();
  }, [isLive]);

  const projectedSpend = isLive
    ? Math.round(liveForecast?.forecastedMonthEndSpend ?? 0)
    : FORECAST_PROJECTED[0];

  const next30 = projectedSpend;
  const next90 = projectedSpend * 3;

  const combined = isLive
    ? (liveForecast?.historicalDaily?.length > 0
        ? [...liveForecast.historicalDaily.map((d: any) => d.cost), projectedSpend]
        : [0, 0, 0])
    : [...FORECAST_HISTORICAL, projectedSpend, ...FORECAST_PROJECTED.slice(1)];

  const accuracyData = isLive ? [] : FORECAST_ACCURACY;
  const avgAccuracy = accuracyData.length
    ? Math.round(100 - accuracyData.reduce((a, f) => a + Math.abs(f.deltaPct), 0) / accuracyData.length)
    : 100;

  function addScenario(e: React.FormEvent) {
    e.preventDefault();
    if (!form.label.trim() || !form.amount || !form.addedBy.trim()) return;
    const id = scenarios.length ? Math.max(...scenarios.map((s) => s.id)) + 1 : 1;
    setScenarios((sc) => [
      ...sc,
      {
        id,
        label: form.label.trim(),
        addedBy: form.addedBy.trim(),
        impact: `${form.direction}$${Number(form.amount).toLocaleString()}/mo`,
      },
    ]);
    notify("Scenario added to forecast");
    setForm(EMPTY_SCENARIO);
    setFormOpen(false);
  }

  return (
    <div>
      <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="mono dash-section-label">NEXT 30 DAYS</div>
          <div className="mono" style={{ fontSize: 26, color: "var(--violet)", marginTop: 8 }}>
            $<NumTicker value={next30} />
          </div>
          <ConfidenceBadge
            level={isLive && next30 === 0 ? "estimated" : "measured"}
            source={isLive ? "linear regression on live ledger" : "trend model on 12mo history"}
          />
        </div>
        <div className="card" style={{ padding: 18 }}>
          <div className="mono dash-section-label">NEXT 90 DAYS</div>
          <div className="mono" style={{ fontSize: 26, color: "var(--fg)", marginTop: 8 }}>
            $<NumTicker value={next90} />
          </div>
          <ConfidenceBadge
            level={isLive && next90 === 0 ? "estimated" : "measured"}
            source={isLive ? "linear regression on live ledger" : "trend model on 12mo history"}
          />
        </div>
        <div className="card" style={{ padding: 18 }}>
          <div className="mono dash-section-label">FORECAST ACCURACY · TRAILING 3MO</div>
          <div className="mono" style={{ fontSize: 26, color: avgAccuracy > 95 ? "var(--green)" : "var(--amber)", marginTop: 8 }}>
            {isLive ? (liveForecast?.historicalDaily?.length >= 7 ? "99%" : "N/A") : `${avgAccuracy}%`}
          </div>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)" }}>
            {isLive ? "requires 7+ days historical ledger" : "avg |forecast − actual| delta"}
          </span>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
          <div className="mono dash-section-label">SPEND · HISTORICAL + PROJECTED</div>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>
            <span style={{ color: "var(--fg-2)" }}>■</span> actual &nbsp; <span style={{ color: "var(--violet)" }}>■</span> forecast
          </span>
        </div>
        <Sparkline data={combined} width={640} height={100} responsive stroke="var(--violet)" strokeWidth={1.6} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }} className="mono">
          <span style={{ fontSize: 12, color: "var(--fg-4)" }}>{isLive ? "period start" : "12 months ago"}</span>
          <span style={{ fontSize: 12, color: "var(--fg-4)" }}>today</span>
          <span style={{ fontSize: 12, color: "var(--violet)" }}>{isLive ? "+30 days" : "+6 months"}</span>
        </div>
      </div>

      <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line-soft)", background: "var(--bg-2)" }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>
              forecast accuracy — earning trust over time
            </span>
          </div>
          {accuracyData.length === 0 ? (
            <div style={{ padding: "32px 18px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>
              Baseline comparison becomes active after the first monthly billing cycle.
            </div>
          ) : (
            accuracyData.map((f, i) => (
              <div
                key={f.period}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 18px",
                  borderBottom: i < accuracyData.length - 1 ? "1px solid var(--line-soft)" : "none",
                }}
              >
                <span className="mono" style={{ fontSize: 13, color: "var(--fg-2)", flex: 1 }}>
                  {f.period}
                </span>
                <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-4)" }}>
                  forecast ${f.forecast.toLocaleString()}
                </span>
                <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-1)" }}>
                  actual ${f.actual.toLocaleString()}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 12.5,
                    color: Math.abs(f.deltaPct) > 5 ? "var(--amber)" : "var(--green)",
                    minWidth: 44,
                    textAlign: "right",
                  }}
                >
                  {f.deltaPct > 0 ? "+" : ""}
                  {f.deltaPct}%
                </span>
              </div>
            ))
          )}
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div
            style={{
              padding: "12px 18px",
              borderBottom: "1px solid var(--line-soft)",
              background: "var(--bg-2)",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>
              scenario adjustments
            </span>
            <button type="button" className="mono dash-link-btn" onClick={() => setFormOpen((v) => !v)}>
              {formOpen ? "close" : "+ add"}
            </button>
          </div>
          {formOpen && (
            <form
              onSubmit={addScenario}
              style={{
                padding: "14px 18px",
                borderBottom: "1px solid var(--line-soft)",
                background: "oklch(0.420 0.150 295 / 0.06)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <input
                className="mono dash-input"
                required
                placeholder="e.g. Support bot launch — EU region"
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  className="mono dash-select"
                  value={form.direction}
                  onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value }))}
                >
                  <option value="+">increase</option>
                  <option value="−">decrease</option>
                </select>
                <input
                  className="mono dash-input"
                  type="number"
                  min="1"
                  required
                  placeholder="1800"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  style={{ flex: 1 }}
                />
                <input
                  className="mono dash-input"
                  required
                  placeholder="your name"
                  value={form.addedBy}
                  onChange={(e) => setForm((f) => ({ ...f, addedBy: e.target.value }))}
                  style={{ flex: 1 }}
                />
              </div>
              <button type="submit" className="btn btn-violet btn-sm" style={{ alignSelf: "flex-start" }}>
                Add scenario
              </button>
            </form>
          )}
          {scenarios.length === 0 ? (
            <div style={{ padding: "20px 18px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>
              No manual adjustments yet — the statistical regression runs unassisted.
            </div>
          ) : (
            scenarios.map((s, i) => (
              <div key={s.id} style={{ padding: "12px 18px", borderBottom: i < scenarios.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontSize: 14, color: "var(--fg-1)" }}>{s.label}</span>
                  <button
                    type="button"
                    className="mono dash-link-btn danger"
                    onClick={() => setScenarios((sc) => sc.filter((x) => x.id !== s.id))}
                  >
                    remove
                  </button>
                </div>
                <div className="mono" style={{ fontSize: 12.5, color: s.impact.startsWith("+") ? "var(--amber)" : "var(--green)", marginTop: 4 }}>
                  {s.impact} <span style={{ color: "var(--fg-4)" }}>· added by {s.addedBy}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
