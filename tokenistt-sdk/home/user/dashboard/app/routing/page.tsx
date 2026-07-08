"use client";

import { useState } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { StatusPill } from "@/components/StatusBadges";
import { ROUTING_RULES } from "@/lib/dashboard-mock-data";

const TYPES = ["cost-based", "latency-based", "policy-based", "fallback-on-outage"];
const MODELS = ["claude-haiku-4.5", "claude-sonnet-4.5", "gpt-4o-mini", "gpt-4o", "gemini-2.5-flash", "deepseek-v3"];

const EMPTY_RULE = { name: "", type: TYPES[0], candidates: [MODELS[0]], minQuality: 95 };

type Rule = (typeof ROUTING_RULES)[number];

export default function RoutingPage() {
  const { notify } = useDashboard();
  const [rules, setRules] = useState<Rule[]>(ROUTING_RULES);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_RULE);
  const [simRuleId, setSimRuleId] = useState(rules[0].id);
  const [simPrompt, setSimPrompt] = useState("Classify this support ticket by priority and sentiment.");
  const [simResult, setSimResult] = useState<string | null>(null);

  const simRule = rules.find((r) => r.id === Number(simRuleId));

  function toggleCandidate(model: string) {
    setForm((f) => ({
      ...f,
      candidates: f.candidates.includes(model) ? f.candidates.filter((m) => m !== model) : [...f.candidates, model],
    }));
  }

  function createRule(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || form.candidates.length === 0) return;
    const id = rules.length ? Math.max(...rules.map((r) => r.id)) + 1 : 1;
    setRules((rs) => [...rs, {
      id, name: form.name.trim(), priority: rs.length + 1, type: form.type,
      candidates: form.candidates, minQuality: form.minQuality / 100, status: "active", fired24h: 0,
    }]);
    notify(`Routing rule "${form.name.trim()}" created`);
    setForm(EMPTY_RULE);
    setFormOpen(false);
  }

  function toggleStatus(id: number) {
    setRules((rs) => rs.map((r) => (r.id !== id ? r : { ...r, status: r.status === "active" ? "paused" : "active" })));
  }

  function runSimulation() {
    if (!simRule) return;
    setSimResult(simRule.candidates[0]);
    notify("Simulation complete");
  }

  return (
    <div>
      <div className="card" style={{ overflow: "hidden", marginBottom: 24 }}>
        <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ padding: "14px 18px", borderRight: "1px solid var(--line-soft)", display: "flex", justifyContent: "space-between" }}>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>before · static routing</div>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--red)" }}>gpt-4o · $0.0043 / req</div>
          </div>
          <div style={{ padding: "14px 18px", display: "flex", justifyContent: "space-between" }}>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--violet)" }}>after · tokenistt routing</div>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--violet)" }}>claude-haiku-4.5 · $0.0011 / req</div>
          </div>
        </div>
        <div className="mobile-stack optimizer-stats" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", background: "var(--bg-2)" }}>
          {[
            { l: "Cost reduction", v: "−74%", accent: true },
            { l: "Providers evaluated", v: "3" },
            { l: "Monthly savings", v: "$184", accent: true },
            { l: "Fallback", v: "automatic" },
            { l: "Eval parity", v: "99.4%" },
          ].map((c, i) => (
            <div key={i} style={{ padding: "14px 18px", borderRight: i < 4 ? "1px solid var(--line-soft)" : "none" }}>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{c.l}</div>
              <div className="mono" style={{ fontSize: 20, color: c.accent ? "var(--violet)" : "var(--fg)", letterSpacing: "-0.02em" }}>{c.v}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="dash-section-head">
        <div>
          <div className="mono dash-section-label">ROUTING POLICIES · {rules.length}</div>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Evaluated top to bottom, first match wins</div>
        </div>
        <button type="button" className="btn btn-violet btn-sm" onClick={() => setFormOpen((v) => !v)}>{formOpen ? "Close" : "+ New policy"}</button>
      </div>

      {formOpen && (
        <form onSubmit={createRule} className="card" style={{ padding: 18, marginBottom: 20, background: "oklch(0.420 0.150 295 / 0.06)" }}>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--violet)", letterSpacing: "0.05em", marginBottom: 12 }}>NEW ROUTING POLICY</div>
          <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>NAME</span>
              <input className="mono dash-input" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="internal-tools — low cost" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>TYPE</span>
              <select className="mono dash-select" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>MIN QUALITY · {form.minQuality}%</span>
              <input type="range" min="80" max="100" value={form.minQuality} onChange={(e) => setForm((f) => ({ ...f, minQuality: Number(e.target.value) }))} />
            </label>
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 6 }}>CANDIDATES · priority order</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {MODELS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => toggleCandidate(m)}
                className="mono"
                style={{
                  padding: "5px 10px", fontSize: 12, borderRadius: 4, cursor: "pointer",
                  border: "1px solid " + (form.candidates.includes(m) ? "var(--violet)" : "var(--line-soft)"),
                  background: form.candidates.includes(m) ? "oklch(0.420 0.150 295 / 0.14)" : "transparent",
                  color: form.candidates.includes(m) ? "var(--violet)" : "var(--fg-3)",
                }}
              >
                {form.candidates.includes(m) ? `${form.candidates.indexOf(m) + 1}. ` : ""}{m}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" className="btn btn-violet btn-sm">Create policy</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFormOpen(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="card" style={{ overflow: "hidden" }}>
        {rules.map((r, i) => (
          <div key={r.id} style={{
            padding: "16px 18px",
            borderBottom: i < rules.length - 1 ? "1px solid var(--line-soft)" : "none",
            display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
            opacity: r.status === "paused" ? 0.55 : 1,
          }}>
            <span className="mono" style={{ fontSize: 13, color: "var(--fg-4)", width: 20 }}>{r.priority}</span>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 15, color: "var(--fg)" }}>{r.name}</span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)", border: "1px solid var(--line-soft)", borderRadius: 3, padding: "1px 5px" }}>{r.type}</span>
              </div>
              <div className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)", marginTop: 4 }}>
                {r.candidates.join(" → ")}
              </div>
            </div>
            <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>min quality {Math.round(r.minQuality * 100)}%</span>
            <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)", minWidth: 90, textAlign: "right" }}>{r.fired24h.toLocaleString()} fired / 24h</span>
            <button type="button" onClick={() => toggleStatus(r.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              <StatusPill status={r.status} />
            </button>
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 18, marginTop: 24 }}>
        <div className="mono dash-section-label" style={{ marginBottom: 14 }}>SIMULATE A REQUEST</div>
        <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>SAMPLE REQUEST</span>
            <input className="mono dash-input" value={simPrompt} onChange={(e) => setSimPrompt(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>AGAINST RULE</span>
            <select className="mono dash-select" value={simRuleId} onChange={(e) => { setSimRuleId(Number(e.target.value)); setSimResult(null); }}>
              {rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-violet btn-sm" disabled={!simPrompt.trim()} onClick={runSimulation}>Run simulation</button>
        </div>
        {simResult && simRule && (
          <div style={{ marginTop: 16, padding: "12px 14px", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>WOULD ROUTE TO</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <span className="mono" style={{ fontSize: 15, color: "var(--violet)" }}>{simResult}</span>
              <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>· min quality {Math.round(simRule.minQuality * 100)}% met · not a live change</span>
            </div>
          </div>
        )}
      </div>

      <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 0, marginTop: 24 }}>
        {[
          { n: "01", t: "Classify", d: "Score each request by complexity, required capability, and latency budget." },
          { n: "02", t: "Rank", d: "Rank every connected provider/model that can meet the quality bar, cheapest first." },
          { n: "03", t: "Verify", d: "Run the candidate against your eval set. Measure quality parity before switching." },
          { n: "04", t: "Route", d: "Send live traffic to the winner. Fall back automatically on quality or latency drift." },
        ].map((s, i) => (
          <div key={i} style={{ padding: "18px 18px", borderRight: i < 3 ? "1px solid var(--line-soft)" : "none", borderTop: "1px solid var(--line-soft)" }}>
            <div className="mono" style={{ fontSize: 12, color: "var(--violet)" }}>{s.n}</div>
            <div style={{ fontSize: 16, marginTop: 8, color: "var(--fg)" }}>{s.t}</div>
            <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.5 }}>{s.d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
