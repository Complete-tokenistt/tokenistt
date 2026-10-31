"use client";

import { useState } from "react";
import Section from "@/components/Section";
import Badge from "@/components/Badge";
import { SimpleTable, fmtTime } from "@/components/SimpleTable";
import { StateNote, gatewayFetch, useGateway } from "@/lib/useGateway";

type Field = { key: string; required: boolean; secret?: boolean; description: string };
type TypeInfo = { type: string; label: string; mode: string[]; fields: Field[] };
type Connector = { id: string; type: string; name: string; status: string; last_sync_at: string | null; last_error: string | null };
type Attribution = { dimension: string; value: string; label: string; cost_usd: string; requests: string };

export default function ConnectorsPage() {
  const list = useGateway<Connector[]>("connectors");
  const types = useGateway<TypeInfo[]>("connectors/types");
  const attribution = useGateway<Attribution[]>("attribution");

  const [type, setType] = useState("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const selected = types.data?.find((t) => t.type === type);

  async function run(id: string, label: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setMessage(null);
    try {
      const out: any = await fn();
      setMessage({ ok: true, text: `${label} succeeded${out?.entities !== undefined ? ` (${out.entities} entities)` : ""}.` });
      list.reload();
      attribution.reload();
    } catch (e: any) {
      setMessage({ ok: false, text: `${label} failed: ${e.message}` });
    } finally {
      setBusy(null);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    await run("create", "Connect", async () => {
      await gatewayFetch("connectors", { method: "POST", body: JSON.stringify({ type, name, config }) });
      setName("");
      setConfig({});
      setType("");
    });
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <Section
        title="Connected systems"
        description="Pull repos, tickets, sprints, customers and people so spend can be attributed to real work. Credentials are encrypted and never shown again."
      >
        <StateNote loading={list.loading} error={list.error} />
        {message && <div className="mono" style={{ fontSize: 13, marginBottom: 10, color: message.ok ? "var(--green)" : "var(--red)" }}>{message.text}</div>}
        {list.data && (
          <SimpleTable
            rows={list.data}
            rowKey={(c) => c.id}
            empty="No connectors yet. Add one below."
            columns={[
              { header: "Name", cell: (c) => (<><div style={{ color: "var(--fg)" }}>{c.name}</div><div className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>{c.type}</div></>) },
              { header: "Status", width: 140, cell: (c) => (<><Badge tone={c.status === "active" ? "ok" : "critical"}>{c.status}</Badge>{c.last_error && <div className="mono" style={{ fontSize: 12, color: "var(--red)" }}>{c.last_error}</div>}</>) },
              { header: "Last sync", width: 190, cell: (c) => fmtTime(c.last_sync_at) },
              {
                header: "", width: 280,
                cell: (c) => (
                  <span style={{ display: "inline-flex", gap: 8 }}>
                    <button className="btn" disabled={busy === c.id} onClick={() => run(c.id, "Test", () => gatewayFetch(`connectors/${c.id}/test`, { method: "POST" }))}>Test</button>
                    <button className="btn" disabled={busy === c.id} onClick={() => run(c.id, "Sync", () => gatewayFetch(`connectors/${c.id}/sync`, { method: "POST" }))}>Sync now</button>
                    <button className="btn" disabled={busy === c.id} onClick={() => confirm(`Delete ${c.name} and its synced entities?`) && run(c.id, "Delete", () => gatewayFetch(`connectors/${c.id}`, { method: "DELETE" }))}>Delete</button>
                  </span>
                ),
              },
            ]}
          />
        )}
      </Section>

      <Section title="Add a connector" description="Credentials are verified before they are saved.">
        <StateNote loading={types.loading} error={types.error} />
        <form onSubmit={create} style={{ display: "grid", gap: 12, maxWidth: 560 }}>
          <select className="mono dash-input" value={type} onChange={(e) => { setType(e.target.value); setConfig({}); }} required aria-label="Connector type">
            <option value="">Choose a system…</option>
            {types.data?.map((t) => <option key={t.type} value={t.type}>{t.label} ({t.mode.join(" + ")})</option>)}
          </select>
          {selected && (
            <>
              <input className="mono dash-input" placeholder="Name (e.g. acme-github)" value={name} onChange={(e) => setName(e.target.value)} required />
              {selected.fields.map((f) => (
                <label key={f.key} style={{ display: "grid", gap: 4 }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>{f.key}{f.required ? " *" : ""} — {f.description}</span>
                  <input
                    className="mono dash-input"
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    required={f.required}
                    value={config[f.key] ?? ""}
                    onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
                  />
                </label>
              ))}
              {selected.mode.includes("webhook") && !selected.mode.includes("pull") && (
                <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>
                  After saving, point your system at <code>/v1/webhooks/connectors/&lt;connector id&gt;</code> and sign payloads with this secret.
                </div>
              )}
              <button className="btn" disabled={busy === "create"}>{busy === "create" ? "Verifying…" : "Connect"}</button>
            </>
          )}
        </form>
      </Section>

      <Section title="Spend by attributed dimension" description="Cost per repo, ticket, sprint, feature, customer and employee — from the x-tokenistt-* headers on each request.">
        <StateNote loading={attribution.loading} error={attribution.error} />
        {attribution.data && (
          <SimpleTable
            rows={attribution.data}
            rowKey={(a) => `${a.dimension}:${a.value}`}
            empty="No attributed spend yet. Send requests with x-tokenistt-repo / -feature / -customer headers."
            columns={[
              { header: "Dimension", width: 130, cell: (a) => a.dimension },
              { header: "Value", cell: (a) => a.label },
              { header: "Requests", width: 110, cell: (a) => a.requests },
              { header: "Cost", width: 120, cell: (a) => `$${Number(a.cost_usd).toFixed(4)}` },
            ]}
          />
        )}
      </Section>
    </div>
  );
}
