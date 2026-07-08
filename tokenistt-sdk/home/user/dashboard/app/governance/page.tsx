"use client";

import { useEffect, useState } from "react";
import type { Policy } from "@/lib/types";
import { StatusPill } from "@/components/StatusBadges";

export default function GovernancePage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [costCenter, setCostCenter] = useState("");
  const [targetModel, setTargetModel] = useState("");
  const [costLimit, setCostLimit] = useState("");
  const [promptKeyword, setPromptKeyword] = useState("");

  const [effect, setEffect] = useState<"block" | "require_approval" | "force_model">("block");
  const [redirectModel, setRedirectModel] = useState("");
  const [customMessage, setCustomMessage] = useState("");

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchPolicies();
  }, []);

  async function fetchPolicies() {
    try {
      setLoading(true);
      const res = await fetch("/api/policies");
      if (!res.ok) throw new Error("Failed to fetch policies");
      const data = await res.json();
      setPolicies(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function togglePolicy(policy: Policy) {
    const updatedStatus = !policy.is_enabled;

    setPolicies((prev) => prev.map((p) => (p.public_id === policy.public_id ? { ...p, is_enabled: updatedStatus } : p)));

    try {
      const res = await fetch("/api/policies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_id: policy.public_id, is_enabled: updatedStatus }),
      });
      if (!res.ok) throw new Error("Failed to update policy status");
    } catch (err: any) {
      setPolicies((prev) => prev.map((p) => (p.public_id === policy.public_id ? { ...p, is_enabled: policy.is_enabled } : p)));
      alert("Error: " + err.message);
    }
  }

  async function deletePolicy(publicId: string) {
    if (!confirm("Are you sure you want to delete this policy?")) return;

    const original = [...policies];
    setPolicies((prev) => prev.filter((p) => p.public_id !== publicId));

    try {
      const res = await fetch(`/api/policies?public_id=${publicId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete policy");
    } catch (err: any) {
      setPolicies(original);
      alert("Error: " + err.message);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name) return;

    try {
      setSaving(true);
      const conditions: any = {};
      if (costCenter) conditions.cost_center = costCenter;
      if (targetModel) conditions.model = targetModel;
      if (costLimit) conditions.cost_limit = parseFloat(costLimit);
      if (promptKeyword) conditions.prompt_keyword = promptKeyword;

      const actions: any = { effect };
      if (effect === "force_model") actions.model = redirectModel || "claude-3-haiku";
      if (customMessage) actions.message = customMessage;

      const res = await fetch("/api/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, is_enabled: true, conditions, actions }),
      });

      if (!res.ok) throw new Error("Failed to create policy");
      const newPolicy = await res.json();

      setPolicies((prev) => [newPolicy, ...prev]);

      setName("");
      setDescription("");
      setCostCenter("");
      setTargetModel("");
      setCostLimit("");
      setPromptKeyword("");
      setEffect("block");
      setRedirectModel("");
      setCustomMessage("");
      setShowAddForm(false);
    } catch (err: any) {
      alert("Error creating policy: " + err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="dash-section-head">
        <div>
          <div className="mono dash-section-label">ACTIVE POLICIES · {policies.filter((p) => p.is_enabled).length}</div>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Evaluated top-to-bottom on every incoming request. The first matching policy triggers immediate action.</div>
        </div>
        <button type="button" className="btn btn-violet btn-sm" onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? "Close builder" : "+ Create New Rule"}
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={handleSubmit} className="card" style={{ padding: 18, marginBottom: 20, background: "oklch(0.420 0.150 295 / 0.06)" }}>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--violet)", letterSpacing: "0.05em", marginBottom: 12 }}>
            POLICY BUILDER · specify match conditions and the enforcement response
          </div>

          <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 14 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>POLICY NAME *</span>
              <input className="mono dash-input" required placeholder="e.g., Block GPT-4 for Interns" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>DESCRIPTION</span>
              <input className="mono dash-input" placeholder="Explain the purpose of this rule" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>

          <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 8 }}>MATCH CONDITIONS · leave blank to match all</div>
          <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>COST CENTER</span>
              <input className="mono dash-input" placeholder="e.g., interns" value={costCenter} onChange={(e) => setCostCenter(e.target.value)} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>MODEL CONTAINS</span>
              <input className="mono dash-input" placeholder="e.g., gpt-4" value={targetModel} onChange={(e) => setTargetModel(e.target.value)} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>COST &gt; (USD)</span>
              <input className="mono dash-input" type="number" step="0.01" placeholder="0.50" value={costLimit} onChange={(e) => setCostLimit(e.target.value)} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>PROMPT KEYWORD</span>
              <input className="mono dash-input" placeholder="e.g., summarize" value={promptKeyword} onChange={(e) => setPromptKeyword(e.target.value)} />
            </label>
          </div>

          <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 8 }}>ACTION &amp; RESPONSE</div>
          <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.4fr", gap: 10 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>ENFORCEMENT ACTION</span>
              <select className="mono dash-select" value={effect} onChange={(e) => setEffect(e.target.value as any)}>
                <option value="block">🚫 Block Request</option>
                <option value="require_approval">⏳ Require Approval</option>
                <option value="force_model">🔄 Force Model Redirection</option>
              </select>
            </label>

            {effect === "force_model" && (
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>REDIRECT MODEL</span>
                <input className="mono dash-input" required placeholder="e.g., claude-3-haiku" value={redirectModel} onChange={(e) => setRedirectModel(e.target.value)} />
              </label>
            )}

            {(effect === "block" || effect === "require_approval") && (
              <label style={{ display: "flex", flexDirection: "column", gap: 6, gridColumn: "span 2" }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>CUSTOM REJECTION MESSAGE</span>
                <input className="mono dash-input" placeholder="Explain the rejection reason to the developer" value={customMessage} onChange={(e) => setCustomMessage(e.target.value)} />
              </label>
            )}
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button type="submit" className="btn btn-violet btn-sm" disabled={saving}>{saving ? "Saving..." : "Add Policy Rule"}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAddForm(false)}>Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="card" style={{ padding: 40, textAlign: "center" }}>
          <div className="mono" style={{ fontSize: 13, color: "var(--fg-3)" }}>Loading…</div>
        </div>
      ) : error ? (
        <div className="card" style={{ padding: 18, borderColor: "var(--red)", color: "var(--red)", fontSize: 13.5 }}>{error}</div>
      ) : policies.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--fg-4)", fontSize: 14 }}>
          No rules configured. Click &quot;Create New Rule&quot; to get started.
        </div>
      ) : (
        <div className="integration-grid">
          {policies.map((policy) => {
            const { conditions, actions } = policy;
            return (
              <div key={policy.public_id} className="card integration-card" style={{ opacity: policy.is_enabled ? 1 : 0.55 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 15.5, color: "var(--fg)" }}>{policy.name}</div>
                    {policy.description && (
                      <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 4 }}>{policy.description}</div>
                    )}
                  </div>
                  <button type="button" onClick={() => togglePolicy(policy)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    <StatusPill status={policy.is_enabled ? "active" : "paused"} />
                  </button>
                </div>

                <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {Object.keys(conditions).length === 0 ? (
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)", border: "1px solid var(--line-soft)", borderRadius: 3, padding: "2px 7px" }}>matches all calls</span>
                  ) : (
                    <>
                      {conditions.cost_center && <span className="mono" style={{ fontSize: 10.5, color: "var(--violet)", border: "1px solid var(--line-soft)", borderRadius: 3, padding: "2px 7px" }}>team: {conditions.cost_center}</span>}
                      {conditions.model && <span className="mono" style={{ fontSize: 10.5, color: "var(--blue)", border: "1px solid var(--line-soft)", borderRadius: 3, padding: "2px 7px" }}>model: {conditions.model}</span>}
                      {conditions.cost_limit && <span className="mono" style={{ fontSize: 10.5, color: "var(--amber)", border: "1px solid var(--line-soft)", borderRadius: 3, padding: "2px 7px" }}>cost &gt; ${conditions.cost_limit.toFixed(2)}</span>}
                      {conditions.prompt_keyword && <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)", border: "1px solid var(--line-soft)", borderRadius: 3, padding: "2px 7px" }}>keyword: &quot;{conditions.prompt_keyword}&quot;</span>}
                    </>
                  )}
                </div>

                <div style={{ marginTop: "auto", paddingTop: 14, borderTop: "1px solid var(--line-soft)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div className="mono" style={{ fontSize: 12, color: actions.effect === "block" ? "var(--red)" : actions.effect === "require_approval" ? "var(--amber)" : "var(--green)" }}>
                    {actions.effect === "block" && "🚫 Block Call"}
                    {actions.effect === "require_approval" && "⏳ Needs Approval"}
                    {actions.effect === "force_model" && `🔄 Route → ${actions.model}`}
                  </div>
                  <button type="button" className="mono dash-link-btn danger" onClick={() => deletePolicy(policy.public_id)}>delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
