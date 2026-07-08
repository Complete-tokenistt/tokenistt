"use client";

import { useState } from "react";
import { Sparkline } from "@/components/Sparkline";
import { ConfidenceBadge, StatusPill } from "@/components/StatusBadges";
import { ROI_INITIATIVES } from "@/lib/dashboard-mock-data";

export default function RoiDashboardPage() {
  const [expanded, setExpanded] = useState<number | null>(null);
  const atRisk = ROI_INITIATIVES.filter((i) => i.atRisk);

  return (
    <div>
      {atRisk.length > 0 && (
        <div className="dash-alert-banner" style={{ marginBottom: 24 }}>
          <span className="mono dash-alert-tag" style={{ color: "var(--red)", borderColor: "oklch(0.7 0.19 25 / 0.4)" }}>AT RISK</span>
          <span style={{ fontSize: 14.5, color: "var(--fg-1)" }}>
            {atRisk.length} initiative{atRisk.length !== 1 ? "s" : ""} trending toward negative margin: <strong>{atRisk.map((i) => i.name).join(", ")}</strong>
          </span>
        </div>
      )}

      <div className="integration-grid">
        {ROI_INITIATIVES.map((i) => (
          <div key={i.id} className="card" style={{ padding: 18, borderColor: i.atRisk ? "oklch(0.7 0.19 25 / 0.35)" : undefined }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div style={{ fontSize: 15.5, color: "var(--fg)" }}>{i.name}</div>
              {i.atRisk && <StatusPill status="at risk" />}
            </div>

            <div className="mono" style={{ fontSize: 30, marginTop: 12, color: i.marginPct > 50 ? "var(--green)" : i.marginPct > 20 ? "var(--amber)" : "var(--red)", letterSpacing: "-0.02em" }}>
              {i.marginPct.toFixed(1)}%
            </div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)", marginTop: -2 }}>margin</div>

            <div style={{ marginTop: 12 }}>
              <Sparkline data={i.trend} width={220} height={36} stroke={i.atRisk ? "var(--red)" : "var(--violet)"} showFill={false} pad={2} strokeWidth={1.3} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
              <div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>COST</div>
                <div className="mono" style={{ fontSize: 14, color: "var(--fg-1)" }}>${i.cost.toLocaleString()}</div>
              </div>
              <div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>VALUE</div>
                <div className="mono" style={{ fontSize: 14, color: "var(--fg-1)" }}>${i.value.toLocaleString()}</div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
              <ConfidenceBadge level={i.confidence} source={i.valueModel} />
              <button type="button" className="mono dash-link-btn" onClick={() => setExpanded(expanded === i.id ? null : i.id)}>
                {expanded === i.id ? "hide calc" : "how calculated"}
              </button>
            </div>

            {expanded === i.id && (
              <div style={{ marginTop: 12, padding: "10px 12px", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 6, fontSize: 13, color: "var(--fg-2)", lineHeight: 1.55 }}>
                <strong style={{ color: "var(--fg-1)" }}>Value model:</strong> {i.valueModel}.
                {" "}ROI = (${i.value.toLocaleString()} − ${i.cost.toLocaleString()}) / ${i.value.toLocaleString()} = {i.marginPct.toFixed(1)}% margin.
                {i.confidence === "estimated" && " Value is partially self-reported or from an incomplete data connection — treat as directional."}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
