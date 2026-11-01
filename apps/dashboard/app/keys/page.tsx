"use client";

import { useState } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { StatusPill } from "@/components/StatusBadges";
import { gatewayFetch, StateNote, useGateway } from "@/lib/useGateway";

type Key = {
  id: string; name: string; key_prefix: string; status: string; budget_cap_usd: string | null;
  budget_period: string; allowed_providers: string[] | null; last_used_at: string | null; created_at: string;
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

export default function KeysPage() {
  const { notify } = useDashboard();
  const keys = useGateway<Key[]>("keys");
  const [name, setName] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const out = await gatewayFetch<{ name: string; token: string }>("keys", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), ...(cap ? { budgetCapUsd: Number(cap) } : {}) }),
      });
      setFresh({ name: out.name, token: out.token });
      setName("");
      setCap("");
      keys.reload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: Key) {
    if (!window.confirm(`Revoke "${k.name}"? Anything using it will start getting 403s. This cannot be undone.`)) return;
    try {
      await gatewayFetch(`keys/${k.id}`, { method: "DELETE" });
      notify(`Revoked "${k.name}"`);
      keys.reload();
    } catch (err: any) {
      notify(err.message);
    }
  }

  const list = keys.data ?? [];

  return (
    <div>
      {fresh && (
        <div className="card" style={{ padding: 18, marginBottom: 20, borderColor: "var(--violet)" }}>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--violet)", letterSpacing: "0.05em", marginBottom: 8 }}>
            KEY CREATED · {fresh.name} · copy it now — it is not shown again
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <code className="mono" style={{ fontSize: 13, wordBreak: "break-all", flex: 1, minWidth: 260 }}>{fresh.token}</code>
            <button type="button" className="btn btn-violet btn-sm" onClick={() => { navigator.clipboard?.writeText(fresh.token); notify("Key copied"); }}>Copy</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFresh(null)}>Done</button>
          </div>
        </div>
      )}

      <form onSubmit={create} className="card" style={{ padding: 18, marginBottom: 24 }}>
        <div className="mono dash-section-label" style={{ marginBottom: 12 }}>NEW API KEY</div>
        <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr auto", gap: 10, alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>NAME</span>
            <input className="mono dash-input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="my-laptop, ci, support-bot…" />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>MONTHLY CAP · USD (optional)</span>
            <input className="mono dash-input" type="number" min="0.01" step="0.01" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="no cap" />
          </label>
          <button type="submit" className="btn btn-violet btn-sm" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create key"}</button>
        </div>
        {error && <div className="mono" style={{ color: "var(--red)", fontSize: 12.5, marginTop: 10 }}>{error}</div>}
        <div style={{ fontSize: 12.5, color: "var(--fg-3)", marginTop: 12 }}>
          Point any OpenAI-compatible tool at this gateway with the key as its API key. See <a href="/onboarding" style={{ color: "var(--violet)" }}>Get started</a> for snippets.
        </div>
      </form>

      <div className="dash-section-head">
        <div className="mono dash-section-label">KEYS · {list.length}</div>
      </div>
      <StateNote loading={keys.loading} error={keys.error} empty={!keys.loading && !keys.error && list.length === 0 ? "No keys yet — create one above." : undefined} />
      {list.length > 0 && (
        <div className="card" style={{ overflow: "hidden" }}>
          {list.map((k, i) => (
            <div key={k.id} style={{
              padding: "14px 18px", borderBottom: i < list.length - 1 ? "1px solid var(--line-soft)" : "none",
              display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", opacity: k.status === "active" ? 1 : 0.55,
            }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 15, color: "var(--fg)" }}>{k.name}</div>
                <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 3 }}>{k.key_prefix}</div>
              </div>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
                {k.budget_cap_usd ? `$${k.budget_cap_usd} / ${k.budget_period}` : "no cap"}
              </span>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)", minWidth: 150 }}>last used {when(k.last_used_at)}</span>
              <StatusPill status={k.status === "active" ? "active" : "revoked"} />
              {k.status === "active" && <button type="button" className="btn btn-ghost btn-sm" onClick={() => revoke(k)}>Revoke</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
