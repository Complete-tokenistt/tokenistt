"use client";

import { useState } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { FreshnessBadge } from "@/components/StatusBadges";
import { BOARD_REPORT_TEMPLATES, CONNECTED_DATA_SOURCES } from "@/lib/dashboard-mock-data";

const CADENCES = ["monthly · 1st", "quarterly", "weekly · Mon 9am"];
const EMPTY_TEMPLATE = { name: "", cadence: CADENCES[0], recipients: "" };

type Template = (typeof BOARD_REPORT_TEMPLATES)[number];

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function BoardReportsPage() {
  const { notify } = useDashboard();
  const [templates, setTemplates] = useState<Template[]>(BOARD_REPORT_TEMPLATES);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_TEMPLATE);
  const degradedSources = CONNECTED_DATA_SOURCES.filter((s) => s.status !== "live");

  function createTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.recipients.trim()) return;
    const id = templates.length ? Math.max(...templates.map((t) => t.id)) + 1 : 1;
    setTemplates((ts) => [...ts, { id, name: form.name.trim(), cadence: form.cadence, recipients: form.recipients.trim(), lastSent: "never", freshness: "live" }]);
    notify(`Template "${form.name.trim()}" created`);
    setForm(EMPTY_TEMPLATE);
    setFormOpen(false);
  }

  function sendNow(id: number) {
    setTemplates((ts) => ts.map((t) => (t.id !== id ? t : { ...t, lastSent: "just now", freshness: "live" })));
    notify("Report sent");
  }

  function exportReport(r: Template, kind: string) {
    const body = `Tokenistt — ${r.name}\n${r.cadence}\nAs of ${r.lastSent}\n\nSpend MTD: $12,680\nBudget utilization: 63%\nActive alerts: 2\n`;
    downloadText(`${r.name.toLowerCase().replace(/\s+/g, "-")}.${kind === "PDF" ? "txt" : "md"}`, body);
    notify(`${kind} exported`);
  }

  return (
    <div>
      {degradedSources.length > 0 && (
        <div className="dash-alert-banner" style={{ marginBottom: 24 }}>
          <span className="mono dash-alert-tag">DATA FRESHNESS</span>
          <span style={{ fontSize: 14.5, color: "var(--fg-1)" }}>
            {degradedSources.map((s) => s.name).join(", ")} {degradedSources.length === 1 ? "is" : "are"} degraded or disconnected — reports touching those numbers are flagged below.
          </span>
        </div>
      )}

      <div className="dash-section-head">
        <div>
          <div className="mono dash-section-label">REPORT TEMPLATES · {templates.length}</div>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Scheduled and distributed automatically, or sent on demand</div>
        </div>
        <button type="button" className="btn btn-violet btn-sm" onClick={() => setFormOpen((v) => !v)}>{formOpen ? "Close" : "+ New template"}</button>
      </div>

      {formOpen && (
        <form onSubmit={createTemplate} className="card" style={{ padding: 18, marginBottom: 20, background: "oklch(0.420 0.150 295 / 0.06)" }}>
          <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.2fr auto", gap: 10, alignItems: "end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>NAME</span>
              <input className="mono dash-input" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Engineering cost review" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>CADENCE</span>
              <select className="mono dash-select" value={form.cadence} onChange={(e) => setForm((f) => ({ ...f, cadence: e.target.value }))}>
                {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>RECIPIENTS</span>
              <input className="mono dash-input" required value={form.recipients} onChange={(e) => setForm((f) => ({ ...f, recipients: e.target.value }))} placeholder="cto@company.com" />
            </label>
            <button type="submit" className="btn btn-violet btn-sm">Create</button>
          </div>
        </form>
      )}

      <div className="card" style={{ overflow: "hidden", marginBottom: 24 }}>
        {templates.map((r, i) => (
          <div key={r.id} style={{ padding: "16px 18px", borderBottom: i < templates.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 15.5, color: "var(--fg)" }}>{r.name}</div>
                <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 4 }}>{r.cadence} · to {r.recipients}</div>
              </div>
              <span className="mono" style={{ fontSize: 12, color: "var(--fg-4)" }}>last sent {r.lastSent}</span>
              <FreshnessBadge status={r.freshness} />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreviewId(previewId === r.id ? null : r.id)}>
                {previewId === r.id ? "Close preview" : "Preview"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => sendNow(r.id)}>Send now</button>
            </div>

            {previewId === r.id && (
              <div style={{ marginTop: 14, padding: "18px 20px", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>preview — as of {r.lastSent}</span>
                  <FreshnessBadge status={r.freshness} lastSync={r.lastSent} />
                </div>
                <h3 style={{ fontSize: 18, color: "var(--fg)", marginBottom: 4 }}>{r.name}</h3>
                <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginBottom: 14 }}>Tokenistt · {r.cadence}</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                  <MiniStat label="Spend MTD" value="$12,680" />
                  <MiniStat label="Budget utilization" value="63%" />
                  <MiniStat label="Active alerts" value="2" />
                </div>
                {r.freshness !== "live" && (
                  <p style={{ fontSize: 12.5, color: "var(--amber)", marginTop: 14 }}>
                    ⚠ One or more underlying data sources are degraded — figures above may lag reality. Resolve before sending externally.
                  </p>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => exportReport(r, "PDF")}>Export PDF</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => exportReport(r, "deck")}>Export deck</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="mono dash-section-label" style={{ marginBottom: 8 }}>DISTRIBUTION</div>
          <p style={{ fontSize: 13.5, color: "var(--fg-3)", lineHeight: 1.6 }}>Recurring email and Slack delivery, on the cadence set per template. Every send carries the freshness badge shown above — a stale number never reaches a deck silently.</p>
        </div>
        <div className="card" style={{ padding: 18 }}>
          <div className="mono dash-section-label" style={{ marginBottom: 8 }}>EXPORT</div>
          <p style={{ fontSize: 13.5, color: "var(--fg-3)", lineHeight: 1.6, marginBottom: 12 }}>Open a report&apos;s preview to export it directly, outside the schedule.</p>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "10px 12px", background: "var(--bg-1)", border: "1px solid var(--line-soft)", borderRadius: 6 }}>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>{label.toUpperCase()}</div>
      <div className="mono" style={{ fontSize: 17, color: "var(--fg)", marginTop: 3 }}>{value}</div>
    </div>
  );
}
