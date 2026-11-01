"use client";

import { useMemo, useState } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { StatusPill } from "@/components/StatusBadges";
import { gatewayFetch, StateNote, useGateway } from "@/lib/useGateway";
import { fmtUsd } from "@/lib/format";

type Target = { provider: string; model: string };
type Rule = {
  id: string; name: string; priority: number; strategy: Strategy; is_enabled: boolean;
  match: { model?: string; cost_center?: string };
  targets: Target[]; fired_24h: number; last_fired_at: string | null;
};
type Strategy = "cheapest" | "fastest" | "policy" | "fallback";
type CatalogModel = { provider: string; model: string; input_per_1m: number | null; output_per_1m: number | null };
type Sim = {
  matched: boolean; requested_model: string; input_tokens: number; output_tokens: number;
  rule?: { name: string; strategy: string };
  candidates?: (Target & { est_cost_usd: number | null; avg_latency_ms: number | null })[];
};

const STRATEGIES: { id: Strategy; label: string; help: string }[] = [
  { id: "cheapest", label: "cheapest", help: "Order targets by estimated request cost from the price catalog." },
  { id: "fastest", label: "fastest", help: "Order targets by observed average latency over the last 24h." },
  { id: "fallback", label: "fallback", help: "Try targets in the order listed; move on when one fails." },
  { id: "policy", label: "policy", help: "Targets in order, limited to providers the API key may use." },
];

const EMPTY_FORM = { name: "", strategy: "cheapest" as Strategy, matchModel: "", priority: 100, targets: [] as Target[] };
const keyOf = (t: Target) => `${t.provider}:${t.model}`;

export default function RoutingPage() {
  const { notify } = useDashboard();
  const rules = useGateway<Rule[]>("routing-rules");
  const catalog = useGateway<CatalogModel[]>("models");

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [simPrompt, setSimPrompt] = useState("Classify this support ticket by priority and sentiment.");
  const [simModel, setSimModel] = useState("gpt-4o");
  const [sim, setSim] = useState<Sim | null>(null);
  const [simError, setSimError] = useState<string | null>(null);

  const list = rules.data ?? [];
  const models = useMemo(() => [...(catalog.data ?? [])].sort((a, b) => keyOf(a).localeCompare(keyOf(b))), [catalog.data]);
  const firedTotal = list.reduce((n, r) => n + r.fired_24h, 0);

  function toggleTarget(t: Target) {
    setForm((f) => ({
      ...f,
      targets: f.targets.some((x) => keyOf(x) === keyOf(t)) ? f.targets.filter((x) => keyOf(x) !== keyOf(t)) : [...f.targets, t],
    }));
  }

  async function createRule(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.name.trim() || form.targets.length === 0) {
      setFormError("Give the rule a name and pick at least one target model.");
      return;
    }
    setBusy(true);
    try {
      await gatewayFetch("routing-rules", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(), strategy: form.strategy, priority: form.priority,
          match: form.matchModel.trim() ? { model: form.matchModel.trim() } : {},
          targets: form.targets,
        }),
      });
      notify(`Routing rule "${form.name.trim()}" created`);
      setForm(EMPTY_FORM);
      setFormOpen(false);
      rules.reload();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function patchRule(r: Rule, body: object, msg: string) {
    try {
      await gatewayFetch(`routing-rules/${r.id}`, { method: "PATCH", body: JSON.stringify(body) });
      notify(msg);
      rules.reload();
    } catch (err: any) {
      notify(err.message);
    }
  }

  async function removeRule(r: Rule) {
    if (!window.confirm(`Delete routing rule "${r.name}"?`)) return;
    try {
      await gatewayFetch(`routing-rules/${r.id}`, { method: "DELETE" });
      notify(`Deleted "${r.name}"`);
      rules.reload();
    } catch (err: any) {
      notify(err.message);
    }
  }

  async function runSimulation() {
    setSimError(null);
    setSim(null);
    try {
      setSim(await gatewayFetch<Sim>("routing-rules/simulate", {
        method: "POST", body: JSON.stringify({ model: simModel.trim(), prompt: simPrompt }),
      }));
    } catch (err: any) {
      setSimError(err.message);
    }
  }

  return (
    <div>
      <div className="card" style={{ overflow: "hidden", marginBottom: 24 }}>
        <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", background: "var(--bg-2)" }}>
          {[
            { l: "Rules", v: String(list.length) },
            { l: "Enabled", v: String(list.filter((r) => r.is_enabled).length) },
            { l: "Rule matches · 24h", v: firedTotal.toLocaleString() },
          ].map((c, i) => (
            <div key={c.l} style={{ padding: "14px 18px", borderRight: i < 2 ? "1px solid var(--line-soft)" : "none" }}>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{c.l}</div>
              <div className="mono" style={{ fontSize: 20, color: "var(--fg)", letterSpacing: "-0.02em" }}>{c.v}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="dash-section-head">
        <div>
          <div className="mono dash-section-label">ROUTING RULES · {list.length}</div>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>
            Lowest priority number first; the first enabled rule that matches a request decides where it goes. With no matching rule, the default provider is used.
          </div>
        </div>
        <button type="button" className="btn btn-violet btn-sm" onClick={() => setFormOpen((v) => !v)}>{formOpen ? "Close" : "+ New rule"}</button>
      </div>

      {formOpen && (
        <form onSubmit={createRule} className="card" style={{ padding: 18, marginBottom: 20, background: "oklch(0.420 0.150 295 / 0.06)" }}>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--violet)", letterSpacing: "0.05em", marginBottom: 12 }}>NEW ROUTING RULE</div>
          <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 0.6fr", gap: 10, marginBottom: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>NAME</span>
              <input className="mono dash-input" required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="summaries — cheapest" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>STRATEGY</span>
              <select className="mono dash-select" value={form.strategy} onChange={(e) => setForm((f) => ({ ...f, strategy: e.target.value as Strategy }))}>
                {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>APPLIES TO MODEL (contains, optional)</span>
              <input className="mono dash-input" value={form.matchModel} onChange={(e) => setForm((f) => ({ ...f, matchModel: e.target.value }))} placeholder="gpt-4" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>PRIORITY</span>
              <input className="mono dash-input" type="number" min={1} value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: Number(e.target.value) || 100 }))} />
            </label>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--fg-3)", marginBottom: 12 }}>{STRATEGIES.find((s) => s.id === form.strategy)?.help}</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)", marginBottom: 6 }}>TARGETS · click to add, order = click order</div>
          <StateNote loading={catalog.loading} error={catalog.error} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14, maxHeight: 180, overflowY: "auto" }}>
            {models.map((m) => {
              const picked = form.targets.findIndex((x) => keyOf(x) === keyOf(m));
              return (
                <button
                  key={keyOf(m)} type="button" className="mono" onClick={() => toggleTarget({ provider: m.provider, model: m.model })}
                  title={m.input_per_1m != null ? `$${m.input_per_1m}/1M in · $${m.output_per_1m}/1M out` : "price unknown"}
                  style={{
                    padding: "5px 10px", fontSize: 12, borderRadius: 4, cursor: "pointer",
                    border: "1px solid " + (picked >= 0 ? "var(--violet)" : "var(--line-soft)"),
                    background: picked >= 0 ? "oklch(0.420 0.150 295 / 0.14)" : "transparent",
                    color: picked >= 0 ? "var(--violet)" : "var(--fg-3)",
                  }}
                >
                  {picked >= 0 ? `${picked + 1}. ` : ""}{keyOf(m)}
                </button>
              );
            })}
          </div>
          {formError && <div className="mono" style={{ color: "var(--red)", fontSize: 12.5, marginBottom: 10 }}>{formError}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={busy} className="btn btn-violet btn-sm">{busy ? "Saving…" : "Create rule"}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFormOpen(false)}>Cancel</button>
          </div>
        </form>
      )}

      <StateNote loading={rules.loading} error={rules.error} empty={list.length === 0 ? "No routing rules yet. Requests use the default provider until you add one." : undefined} />
      {list.length > 0 && (
        <div className="card" style={{ overflow: "hidden" }}>
          {list.map((r, i) => (
            <div key={r.id} style={{
              padding: "16px 18px", borderBottom: i < list.length - 1 ? "1px solid var(--line-soft)" : "none",
              display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", opacity: r.is_enabled ? 1 : 0.55,
            }}>
              <span className="mono" style={{ fontSize: 13, color: "var(--fg-4)", width: 28 }}>{r.priority}</span>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, color: "var(--fg)" }}>{r.name}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)", border: "1px solid var(--line-soft)", borderRadius: 3, padding: "1px 5px" }}>{r.strategy}</span>
                  {r.match?.model && <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>model contains “{r.match.model}”</span>}
                </div>
                <div className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)", marginTop: 4 }}>
                  {r.targets.map(keyOf).join(" → ")}
                </div>
              </div>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)", minWidth: 110, textAlign: "right" }}>{r.fired_24h.toLocaleString()} matched / 24h</span>
              <button type="button" onClick={() => patchRule(r, { is_enabled: !r.is_enabled }, r.is_enabled ? `Paused "${r.name}"` : `Enabled "${r.name}"`)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                <StatusPill status={r.is_enabled ? "active" : "paused"} />
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeRule(r)}>Delete</button>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 18, marginTop: 24 }}>
        <div className="mono dash-section-label" style={{ marginBottom: 6 }}>DRY-RUN A REQUEST</div>
        <div style={{ fontSize: 13, color: "var(--fg-3)", marginBottom: 14 }}>
          Runs your real rules and the price catalog against a hypothetical request. Nothing is sent to a provider.
        </div>
        <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>PROMPT</span>
            <input className="mono dash-input" value={simPrompt} onChange={(e) => setSimPrompt(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>REQUESTED MODEL</span>
            <input className="mono dash-input" value={simModel} onChange={(e) => setSimModel(e.target.value)} />
          </label>
          <button type="button" className="btn btn-violet btn-sm" disabled={!simModel.trim()} onClick={runSimulation}>Run</button>
        </div>
        {simError && <div className="mono" style={{ color: "var(--red)", fontSize: 12.5, marginTop: 12 }}>{simError}</div>}
        {sim && (
          <div style={{ marginTop: 16, padding: "12px 14px", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 6 }}>
            {!sim.matched ? (
              <span className="mono" style={{ fontSize: 13, color: "var(--fg-2)" }}>
                No rule matches “{sim.requested_model}” — the request would use default routing.
              </span>
            ) : (
              <>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>
                  MATCHED “{sim.rule?.name}” ({sim.rule?.strategy}) · ~{sim.input_tokens} in / {sim.output_tokens} out tokens
                </span>
                {sim.candidates?.map((c, i) => (
                  <div key={keyOf(c)} className="mono" style={{ display: "flex", gap: 14, marginTop: 6, fontSize: 13, color: i === 0 ? "var(--violet)" : "var(--fg-3)" }}>
                    <span>{i + 1}. {keyOf(c)}</span>
                    <span>{c.est_cost_usd != null ? fmtUsd(c.est_cost_usd, 6) : "price unknown"}</span>
                    <span>{c.avg_latency_ms != null ? `${Math.round(c.avg_latency_ms)} ms avg` : "no latency data"}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
