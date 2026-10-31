"use client";

import { useState, type ReactNode } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { ConfidenceBadge } from "@/components/StatusBadges";
import { SIMULATOR_BASELINE, TEAMS } from "@/lib/dashboard-mock-data";

const VARIABLES = ["model routing", "provider mix", "budget cap", "routing rule priority"];

const IMPACT: Record<string, { spend: number; latency: number; quality: number }> = {
  "model routing": { spend: -0.22, latency: 0.08, quality: -0.01 },
  "provider mix": { spend: -0.10, latency: -0.05, quality: 0.0 },
  "budget cap": { spend: -0.15, latency: 0, quality: 0 },
  "routing rule priority": { spend: -0.06, latency: -0.12, quality: 0.01 },
};

export default function SimulatorPage() {
  const { notify } = useDashboard();
  const [variable, setVariable] = useState(VARIABLES[0]);
  const [intensity, setIntensity] = useState(50);
  const [saved, setSaved] = useState<{ id: number; variable: string; intensity: number; spend: number }[]>([]);

  const factor = intensity / 100;
  const impact = IMPACT[variable];
  const projected = {
    spend: SIMULATOR_BASELINE.spend * (1 + impact.spend * factor),
    latency: Math.round(SIMULATOR_BASELINE.avgLatency * (1 + impact.latency * factor)),
    quality: (SIMULATOR_BASELINE.qualityScore * (1 + impact.quality * factor)).toFixed(1),
  };
  const dataQuality = intensity > 80 ? "estimated" : "measured";

  function saveScenario() {
    setSaved((s) => [{ id: Date.now(), variable, intensity, spend: projected.spend }, ...s]);
    notify("Scenario saved");
  }

  function shareScenario(s: { variable: string; intensity: number }) {
    const url = `${window.location.origin}/simulator?variable=${encodeURIComponent(s.variable)}&intensity=${s.intensity}`;
    navigator.clipboard?.writeText(url);
    notify("Share link copied to clipboard");
  }

  return (
    <div>
      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div className="mono dash-section-label" style={{ marginBottom: 14 }}>WHAT IF…</div>
        <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 16, alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>VARIABLE</span>
            <select className="mono dash-select" value={variable} onChange={(e) => setVariable(e.target.value)}>
              {VARIABLES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>CHANGE INTENSITY · {intensity}%</span>
            <input type="range" min="0" max="100" value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} />
          </label>
          <button type="button" className="btn btn-violet btn-sm" onClick={saveScenario}>Save scenario</button>
        </div>
      </div>

      <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 24 }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="mono dash-section-label" style={{ marginBottom: 12 }}>CURRENT (replayed against real history)</div>
          <Row label="Monthly spend" value={`$${SIMULATOR_BASELINE.spend.toLocaleString()}`} />
          <Row label="Requests" value={SIMULATOR_BASELINE.requests.toLocaleString()} />
          <Row label="Avg latency" value={`${SIMULATOR_BASELINE.avgLatency}ms`} />
          <Row label="Quality score" value={String(SIMULATOR_BASELINE.qualityScore)} last />
        </div>
        <div className="card" style={{ padding: 18, borderColor: "oklch(0.420 0.150 295 / 0.35)", background: "oklch(0.420 0.150 295 / 0.06)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
            <div className="mono dash-section-label" style={{ color: "var(--violet)" }}>PROJECTED</div>
            <ConfidenceBadge level={dataQuality} source={`${variable} @ ${intensity}% change, replayed on 30d history`} />
          </div>
          <Row label="Monthly spend" value={`$${Math.round(projected.spend).toLocaleString()}`} delta={impact.spend * factor} />
          <Row label="Requests" value={SIMULATOR_BASELINE.requests.toLocaleString()} />
          <Row label="Avg latency" value={`${projected.latency}ms`} delta={impact.latency * factor} />
          <Row label="Quality score" value={projected.quality} delta={impact.quality * factor} last />
        </div>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line-soft)", background: "var(--bg-2)" }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>saved scenarios · {saved.length} · shareable for planning discussions</span>
        </div>
        {saved.length === 0 && (
          <div style={{ padding: "24px 18px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>No scenarios saved yet.</div>
        )}
        {saved.map((s, i) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 18px", borderBottom: i < saved.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
            <span className="mono" style={{ fontSize: 13.5, color: "var(--fg-1)", flex: 1 }}>{s.variable} · {s.intensity}% change</span>
            <span className="mono" style={{ fontSize: 13, color: "var(--violet)" }}>${Math.round(s.spend).toLocaleString()}/mo</span>
            <button type="button" className="mono dash-link-btn" onClick={() => shareScenario(s)}>share →</button>
          </div>
        ))}
      </div>

      <p style={{ fontSize: 12.5, color: "var(--fg-4)", marginTop: 12 }}>
        One variable at a time · replayed against {TEAMS.length} teams&apos; actual 30-day history · not a live production change.
      </p>
    </div>
  );
}

function Row({ label, value, delta, last = false }: { label: string; value: string; delta?: number; last?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: last ? "none" : "1px solid var(--line-soft)" }}>
      <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mono" style={{ fontSize: 14, color: "var(--fg-1)" }}>{value}</span>
        {delta != null && delta !== 0 && (
          <span className="mono" style={{ fontSize: 12, color: delta < 0 ? "var(--green)" : "var(--amber)" }}>
            {delta > 0 ? "+" : ""}{Math.round(delta * 100)}%
          </span>
        )}
      </span>
    </div>
  );
}
