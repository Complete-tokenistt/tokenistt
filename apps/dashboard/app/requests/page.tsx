"use client";

import { useCallback, useEffect, useState } from "react";
import Section from "@/components/Section";
import Badge from "@/components/Badge";
import { SimpleTable, fmtTime, fmtUsd } from "@/components/SimpleTable";
import { StateNote, gatewayFetch } from "@/lib/useGateway";

type Req = {
  id: string; request_id: string | null; provider: string; model: string; actor: string | null; cost_center: string;
  cost_usd: string; prompt_tokens: number; completion_tokens: number; status: string; error_code: string | null;
  duration_ms: number | null; created_at: string;
};
type Page = { data: Req[]; next_before: string | null };

export default function RequestsPage() {
  const [rows, setRows] = useState<Req[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ limit: "50" });
      if (status) q.set("status", status);
      if (before) q.set("before", before);
      const page = await gatewayFetch<Page>(`requests?${q}`);
      setRows((prev) => (before ? [...prev, ...page.data] : page.data));
      setNext(page.next_before);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  return (
    <Section
      title="Request history"
      description="Every request through the gateway, newest first. Prompt and response text is never stored."
      action={
        <select className="mono dash-input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="rate_limited">Rate limited</option>
        </select>
      }
    >
      <StateNote loading={loading && rows.length === 0} error={error} />
      {!error && (
        <SimpleTable
          rows={rows}
          rowKey={(r) => r.id}
          empty={loading ? "" : "No requests yet. Send one through the gateway and it will show up here."}
          columns={[
            { header: "When", width: 180, cell: (r) => fmtTime(r.created_at) },
            { header: "Model", cell: (r) => (<><div>{r.model}</div><div className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>{r.provider}</div></>) },
            { header: "Who", cell: (r) => (<><div>{r.actor ?? "—"}</div><div className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>{r.cost_center}</div></>) },
            { header: "Tokens", width: 110, cell: (r) => `${r.prompt_tokens} → ${r.completion_tokens}` },
            { header: "Cost", width: 100, cell: (r) => fmtUsd(r.cost_usd) },
            { header: "Latency", width: 90, cell: (r) => (r.duration_ms === null ? "—" : `${r.duration_ms} ms`) },
            { header: "Status", width: 130, cell: (r) => <Badge tone={r.status === "success" ? "ok" : "critical"}>{r.error_code ?? r.status}</Badge> },
          ]}
        />
      )}
      {next && (
        <button className="btn" style={{ marginTop: 14 }} disabled={loading} onClick={() => load(next)}>
          {loading ? "Loading…" : "Load older"}
        </button>
      )}
    </Section>
  );
}
