"use client";

import { useState, useEffect } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { StatusPill } from "@/components/StatusBadges";
import { BUDGET_POLICIES, BUDGET_ALERT_HISTORY, TEAMS } from "@/lib/dashboard-mock-data";

const ACTIONS = ["alert only", "auto-throttle", "hard cap", "alert + page oncall"];
const HARD_ACTIONS = ["hard cap"];
const SCOPES = [...TEAMS.map((t) => t.name), "workspace-wide"];
const THRESHOLD_OPTIONS = [75, 80, 90, 95, 100];

const EMPTY_FORM = { scope: SCOPES[0], cap: "", period: "monthly", action: ACTIONS[0], mode: "soft", thresholds: [75, 90] };

function enforcementMode(action: string) {
  return HARD_ACTIONS.includes(action) ? "hard" : "soft";
}

function spentFor(scope: string) {
  if (scope === "workspace-wide") return TEAMS.reduce((a, t) => a + t.spend, 0);
  return TEAMS.find((t) => t.name === scope)?.spend ?? 0;
}

function statusFor(spent: number, cap: number) {
  if (cap <= 0) return "ok";
  const pct = spent / cap;
  if (pct >= 1) return "breached";
  if (pct >= 0.85) return "warning";
  return "ok";
}

type Policy = (typeof BUDGET_POLICIES)[number];

export default function BudgetsPage() {
  const { isLive } = useDashboard();
  const [policies, setPolicies] = useState<Policy[]>(isLive ? [] : BUDGET_POLICIES);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    if (!isLive) {
      setPolicies(BUDGET_POLICIES);
      return;
    }

    async function fetchBudgets() {
      try {
        const res = await fetch("/api/budgets");
        if (!res.ok) return;
        const data = await res.json();
        if (data?.budgets && Array.isArray(data.budgets)) {
          const mapped: Policy[] = data.budgets.map((b: any, index: number) => {
            const cap = Number(b.budget_usd ?? b.cap_usd) || 0;
            const spent = Number(b.spend_usd ?? b.used_usd) || 0;
            return {
              id: Number(b.id) || index + 1,
              scope: b.name || `${b.scope_type || b.cost_center || "Workspace"} budget`,
              cap,
              spent,
              period: b.period || "monthly",
              action: b.enforcement_mode === "hard_cap" ? "hard cap" : "auto-throttle",
              thresholds: [Number(b.warn_threshold_pct) || 80, Number(b.critical_threshold_pct) || 90],
              status: statusFor(spent, cap),
            };
          });
          setPolicies(mapped);
        }
      } catch (err) {
        console.warn("Could not load /api/budgets:", err);
      }
    }
    fetchBudgets();
  }, [isLive]);

  function openNew() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }

  function openEdit(policy: Policy) {
    setEditingId(policy.id);
    setForm({
      scope: policy.scope,
      cap: String(policy.cap),
      period: policy.period,
      action: policy.action,
      mode: enforcementMode(policy.action),
      thresholds: policy.thresholds || [75, 90],
    });
    setFormOpen(true);
  }

  function toggleThreshold(t: number) {
    setForm((f) => ({
      ...f,
      thresholds: f.thresholds.includes(t) ? f.thresholds.filter((x) => x !== t) : [...f.thresholds, t].sort((a, b) => a - b),
    }));
  }

  function setMode(mode: string) {
    setForm((f) => ({
      ...f,
      mode,
      action: mode === "hard" ? "hard cap" : HARD_ACTIONS.includes(f.action) ? "alert only" : f.action,
    }));
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
  }

  async function removePolicy(id: number) {
    setPolicies((p) => p.filter((x) => x.id !== id));
    try {
      await fetch(`/api/budgets?id=${id}`, { method: "DELETE" });
    } catch (err) {
      console.warn("Error deleting budget from API:", err);
    }
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    const cap = Number(form.cap);
    if (!form.scope || !cap || cap <= 0) return;
    const spent = spentFor(form.scope);
    const status = statusFor(spent, cap);

    try {
      await fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.scope,
          scope_type: form.scope === "workspace-wide" ? "organization" : "team",
          cap_usd: cap,
          period: form.period,
          warn_threshold_pct: form.thresholds[0] || 80,
          critical_threshold_pct: form.thresholds[1] || 90,
          enforcement_mode: form.mode === "hard" ? "hard_cap" : "alert_only",
        }),
      });
    } catch (err) {
      console.warn("Error saving budget to API:", err);
    }

    if (editingId != null) {
      setPolicies((p) => p.map((x) => (x.id === editingId ? { ...x, scope: form.scope, cap, period: form.period, action: form.action, thresholds: form.thresholds, spent, status } : x)));
    } else {
      const id = policies.length ? Math.max(...policies.map((x) => x.id)) + 1 : 1;
      setPolicies((p) => [...p, { id, scope: form.scope, cap, spent, period: form.period, action: form.action, thresholds: form.thresholds, status }]);
    }
    closeForm();
  }

  const alertHistory = isLive ? [] : BUDGET_ALERT_HISTORY;

  return (
    <div>
      <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 24 }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line-soft)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--bg-2)" }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>tokenistt · budget policies · {policies.length}</span>
            <button type="button" className="btn btn-violet btn-sm" onClick={openNew}>+ New policy</button>
          </div>

          {formOpen && (
            <form onSubmit={submitForm} style={{ padding: "16px 18px", borderBottom: "1px solid var(--line-soft)", background: "oklch(0.420 0.150 295 / 0.06)" }}>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--violet)", letterSpacing: "0.05em", marginBottom: 12 }}>
                {editingId != null ? "EDIT POLICY" : "NEW POLICY"} · multi-level budget cap
              </div>
              <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1.3fr auto", gap: 10, alignItems: "end" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>SCOPE</span>
                  <select value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))} className="mono dash-select">
                    {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>CAP ($)</span>
                  <input type="number" min="1" required value={form.cap} onChange={(e) => setForm((f) => ({ ...f, cap: e.target.value }))} placeholder="5000" className="mono dash-input" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>PERIOD</span>
                  <select value={form.period} onChange={(e) => setForm((f) => ({ ...f, period: e.target.value }))} className="mono dash-select">
                    <option value="monthly">monthly</option>
                    <option value="weekly">weekly</option>
                    <option value="daily">daily</option>
                  </select>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>ACTION</span>
                  <select value={form.action} onChange={(e) => setForm((f) => ({ ...f, action: e.target.value, mode: enforcementMode(e.target.value) }))} className="mono dash-select">
                    {(form.mode === "hard" ? HARD_ACTIONS : ACTIONS.filter((a) => !HARD_ACTIONS.includes(a))).map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="submit" className="btn btn-violet btn-sm">{editingId != null ? "Save" : "Create"}</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={closeForm}>Cancel</button>
                </div>
              </div>

              <div style={{ display: "flex", gap: 20, marginTop: 16, flexWrap: "wrap" }}>
                <div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 6 }}>ENFORCEMENT MODE</div>
                  <div style={{ display: "inline-flex", border: "1px solid var(--line-soft)", borderRadius: 6, overflow: "hidden" }}>
                    {["soft", "hard"].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        className="mono"
                        style={{
                          padding: "6px 14px", fontSize: 12.5, border: "none", cursor: "pointer",
                          background: form.mode === m ? (m === "hard" ? "var(--red)" : "var(--violet-deep)") : "transparent",
                          color: form.mode === m ? "#fff" : "var(--fg-3)",
                        }}
                      >
                        {m === "soft" ? "◐ soft alert" : "● hard block"}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 6 }}>ALERT THRESHOLDS</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {THRESHOLD_OPTIONS.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => toggleThreshold(t)}
                        className="mono"
                        style={{
                          padding: "5px 9px", fontSize: 12, borderRadius: 4, cursor: "pointer",
                          border: "1px solid " + (form.thresholds.includes(t) ? "var(--violet)" : "var(--line-soft)"),
                          background: form.thresholds.includes(t) ? "oklch(0.420 0.150 295 / 0.14)" : "transparent",
                          color: form.thresholds.includes(t) ? "var(--violet)" : "var(--fg-3)",
                        }}
                      >
                        {t}%
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </form>
          )}

          <div className="data-table-wrap">
            <div style={{ minWidth: 620 }}>
              <div className="mono" style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 1fr 0.9fr 0.9fr", padding: "8px 18px", borderBottom: "1px solid var(--line-soft)", fontSize: 11.5, color: "var(--fg-4)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <span>Scope</span><span>Cap / spent</span><span>Enforcement</span><span>Status</span><span style={{ textAlign: "right" }}>Actions</span>
              </div>
              {policies.length === 0 ? (
                <div style={{ padding: "36px 18px", textAlign: "center", color: "var(--fg-4)" }}>
                  <div style={{ fontSize: 14.5, color: "var(--fg-2)", marginBottom: 6 }}>No budget policies configured yet</div>
                  <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 440, margin: "0 auto 14px" }}>
                    Configure monthly or weekly caps per team or workspace to prevent unexpected spend overruns.
                  </p>
                  <button type="button" className="btn btn-violet btn-sm" onClick={openNew}>
                    + Create First Budget Policy
                  </button>
                </div>
              ) : (
                policies.map((b, i) => {
                  const pct = b.cap > 0 ? Math.round((b.spent / b.cap) * 100) : 0;
                  return (
                    <div key={b.id} style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 1fr 0.9fr 0.9fr", padding: "13px 18px", borderBottom: i < policies.length - 1 ? "1px solid var(--line-soft)" : "none", alignItems: "center" }}>
                      <span className="mono" style={{ fontSize: 14, color: "var(--fg)" }}>{b.scope}</span>
                      <span className="mono" style={{ fontSize: 13, color: b.status === "breached" ? "var(--red)" : "var(--fg-2)" }}>
                        ${b.spent.toLocaleString()} / ${b.cap.toLocaleString()} <span style={{ color: "var(--fg-4)" }}>· {pct}%</span>
                      </span>
                      <div>
                        <span className="mono" style={{ fontSize: 12.5, color: enforcementMode(b.action) === "hard" ? "var(--red)" : "var(--violet)" }}>
                          {enforcementMode(b.action) === "hard" ? "● hard" : "◐ soft"}
                        </span>
                        <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)", marginTop: 2 }}>{b.action}</div>
                      </div>
                      <StatusPill status={b.status} />
                      <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
                        <button type="button" className="mono dash-link-btn" onClick={() => openEdit(b)}>edit</button>
                        <button type="button" className="mono dash-link-btn danger" onClick={() => removePolicy(b.id)}>delete</button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line-soft)", background: "var(--bg-2)" }}>
            <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>alert history log</span>
          </div>
          <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
            {alertHistory.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--fg-4)", textAlign: "center", padding: "16px 0" }}>
                No budget alerts or breach events recorded.
              </div>
            ) : (
              alertHistory.map((a, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }} className="mono">
                    <span style={{ color: a.sev === "breach" ? "var(--red)" : "var(--amber)" }}>●</span>
                    <span style={{ fontSize: 13, color: "var(--fg)" }}>{a.scope}</span>
                    <span style={{ fontSize: 12, color: "var(--fg-4)", marginLeft: "auto" }}>{a.t}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--fg-3)", paddingLeft: 16, lineHeight: 1.45 }}>
                    crossed <span style={{ color: "var(--fg-2)" }}>{a.threshold}</span> → {a.action}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="dash-section" style={{ marginTop: 24 }}>
        <div className="mono dash-section-label" style={{ marginBottom: 14 }}>ENFORCEMENT MODES</div>
        <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {[
            { t: "Alert only", d: "Notify budget owners via Slack/email. Traffic is unaffected.", icon: "◐" },
            { t: "Auto-throttle", d: "Downgrade to cheaper models automatically once 90% of cap is reached.", icon: "◑" },
            { t: "Hard cap", d: "Reject requests once the cap is hit until the next billing cycle.", icon: "●" },
          ].map((m) => (
            <div key={m.t} className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 18, color: "var(--violet)", marginBottom: 10 }}>{m.icon}</div>
              <div style={{ fontSize: 15, color: "var(--fg)" }}>{m.t}</div>
              <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.55 }}>{m.d}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
