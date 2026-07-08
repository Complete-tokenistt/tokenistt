"use client";

import { useState } from "react";
import { Sparkline } from "@/components/Sparkline";
import { MODEL_COMPARISON, MODEL_COMPARISON_RECOMMENDATION } from "@/lib/dashboard-mock-data";

const TASK_TYPES = ["support-classification", "code-review", "doc-qa"];

export default function ModelComparisonPage() {
  const [taskType, setTaskType] = useState(TASK_TYPES[0]);
  const rows = taskType === MODEL_COMPARISON_RECOMMENDATION.taskType ? MODEL_COMPARISON : [];
  const cheapest = rows.length ? Math.min(...rows.map((r) => r.cost)) : 0;

  return (
    <div>
      <div className="dash-range-bar">
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>task type</span>
          <select className="mono dash-select" value={taskType} onChange={(e) => setTaskType(e.target.value)}>
            {TASK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--fg-4)", fontSize: 14 }}>
          No comparison data yet for &quot;{taskType}&quot; — connect more traffic tagged with this task type.
        </div>
      ) : (
        <>
          <div className="card" style={{ overflow: "hidden", marginBottom: 24 }}>
            <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line-soft)", background: "var(--bg-2)" }}>
              <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>tokenistt · side-by-side · {taskType}</span>
            </div>
            <div className="data-table-wrap">
              <div style={{ minWidth: 640 }}>
                <div className="mono" style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 1.2fr", padding: "8px 18px", borderBottom: "1px solid var(--line-soft)", fontSize: 11.5, color: "var(--fg-4)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  <span>Model</span><span>Cost / req</span><span>Latency</span><span>Quality</span><span>Trend · 6 releases</span>
                </div>
                {rows.map((r, i) => (
                  <div key={r.model} style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 1.2fr", padding: "13px 18px", borderBottom: i < rows.length - 1 ? "1px solid var(--line-soft)" : "none", alignItems: "center" }}>
                    <div>
                      <span className="mono" style={{ fontSize: 14, color: r.model === MODEL_COMPARISON_RECOMMENDATION.recommended ? "var(--violet)" : "var(--fg)" }}>{r.model}</span>
                      {r.model === MODEL_COMPARISON_RECOMMENDATION.recommended && <span className="mono" style={{ fontSize: 10, color: "var(--violet)", marginLeft: 6 }}>● RECOMMENDED</span>}
                      <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)", marginTop: 2 }}>{r.provider}</div>
                    </div>
                    <span className="mono" style={{ fontSize: 13.5, color: r.cost === cheapest ? "var(--green)" : "var(--fg-2)" }}>${r.cost.toFixed(4)}</span>
                    <span className="mono" style={{ fontSize: 13.5, color: "var(--fg-2)" }}>{r.latency}ms</span>
                    <span className="mono" style={{ fontSize: 13.5, color: r.quality >= 95 ? "var(--green)" : r.quality >= 90 ? "var(--amber)" : "var(--fg-2)" }}>{r.quality}</span>
                    <Sparkline data={r.trend} width={130} height={26} stroke="var(--violet)" showFill={false} showDot={false} pad={2} strokeWidth={1.2} />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 20, background: "oklch(0.420 0.150 295 / 0.08)", borderColor: "oklch(0.420 0.150 295 / 0.30)" }}>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--violet)", letterSpacing: "0.05em", marginBottom: 8 }}>SWITCH RECOMMENDATION</div>
            <div style={{ fontSize: 16, color: "var(--fg)" }}>Use <span className="mono" style={{ color: "var(--violet)" }}>{MODEL_COMPARISON_RECOMMENDATION.recommended}</span> for {taskType}</div>
            <p style={{ fontSize: 14, color: "var(--fg-2)", marginTop: 8, lineHeight: 1.6 }}>{MODEL_COMPARISON_RECOMMENDATION.reasoning}</p>
          </div>
        </>
      )}
    </div>
  );
}
