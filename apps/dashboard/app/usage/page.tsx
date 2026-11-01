"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { StatusPill } from "@/components/StatusBadges";

type UsageRow = {
  id: string; ts: string; team: string; project: string; provider: string; model: string;
  tokensIn: number; tokensOut: number; latencyMs: number; status: string; cost: number;
};

function usageToCsv(rows: UsageRow[]) {
  const header = "id,timestamp,team,project,provider,model,tokens_in,tokens_out,cost_usd,latency_ms,status";
  const lines = rows.map((r) => [r.id, r.ts, r.team, r.project, r.provider, r.model, r.tokensIn, r.tokensOut, r.cost, r.latencyMs, r.status].join(","));
  return [header, ...lines].join("\n");
}

const ALL = "all";

export default function UsagePage() {
  const [team, setTeam] = useState(ALL);
  const [provider, setProvider] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [range, setRange] = useState("24h");
  const [openId, setOpenId] = useState<string | null>(null);
  const [liveRequests, setLiveRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setLoadError(false);

    const params = new URLSearchParams();
    params.set("range", range);
    if (team !== ALL) params.set("team", team);
    if (provider !== ALL) params.set("provider", provider);
    if (status !== ALL) params.set("status", status);

    fetch(`/api/usage?${params.toString()}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!mounted) return;
        if (data?.requests) setLiveRequests(data.requests);
        else setLoadError(true);
      })
      .catch((err) => {
        console.warn("Could not load /api/usage:", err);
        if (mounted) setLoadError(true);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [range, team, provider, status]);

  const rawRows: UsageRow[] = liveRequests.map((r) => ({
        id: r.id,
        ts: r.time,
        team: r.team,
        project: r.project,
        provider: r.provider,
        model: r.model,
        tokensIn: r.inputTokens,
        tokensOut: r.outputTokens,
        latencyMs: r.durationMs,
        status: r.status,
        cost: r.cost,
      }));

  const teams = useMemo(() => [ALL, ...Array.from(new Set(rawRows.map((r) => r.team)))], [rawRows]);
  const providers = useMemo(() => [ALL, ...Array.from(new Set(rawRows.map((r) => r.provider)))], [rawRows]);

  const rows = useMemo(
    () =>
      rawRows.filter(
        (r) =>
          (team === ALL || r.team === team) &&
          (provider === ALL || r.provider === provider) &&
          (status === ALL || r.status === status)
      ),
    [rawRows, team, provider, status]
  );

  const totalCost = rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);
  const errorRate = rows.length
    ? Math.round((rows.filter((r) => r.status !== "success").length / rows.length) * 100)
    : 0;

  function exportCsv() {
    const csv = usageToCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tokenistt-usage-${range}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="dash-range-bar">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select className="mono dash-select" value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="1h">last hour</option>
            <option value="24h">last 24h</option>
            <option value="7d">last 7 days</option>
            <option value="30d">last 30 days</option>
          </select>
          <select className="mono dash-select" value={team} onChange={(e) => setTeam(e.target.value)}>
            {teams.map((t) => (
              <option key={t} value={t}>
                {t === ALL ? "all teams" : t}
              </option>
            ))}
          </select>
          <select className="mono dash-select" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p === ALL ? "all providers" : p}
              </option>
            ))}
          </select>
          <select className="mono dash-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value={ALL}>all statuses</option>
            <option value="success">success</option>
            <option value="error">error</option>
            <option value="throttled">throttled</option>
          </select>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={rows.length === 0}>
          ↓ Export CSV
        </button>
      </div>

      <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 20 }}>
        <div className="card" style={{ padding: 16 }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)", letterSpacing: "0.05em" }}>
            REQUESTS
          </div>
          <div className="mono" style={{ fontSize: 20, color: "var(--fg)", marginTop: 4 }}>
            {rows.length.toLocaleString()}
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)", letterSpacing: "0.05em" }}>
            COST (filtered)
          </div>
          <div className="mono" style={{ fontSize: 20, color: "var(--violet)", marginTop: 4 }}>
            ${totalCost.toFixed(4)}
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)", letterSpacing: "0.05em" }}>
            ERROR / THROTTLE RATE
          </div>
          <div className="mono" style={{ fontSize: 20, color: errorRate > 10 ? "var(--amber)" : "var(--fg)", marginTop: 4 }}>
            {errorRate}%
          </div>
        </div>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line-soft)", background: "var(--bg-2)" }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>
            tokenistt · request log · {rows.length} requests
          </span>
        </div>
        <div className="data-table-wrap">
          <div style={{ minWidth: 780 }}>
            <div
              className="mono"
              style={{
                display: "grid",
                gridTemplateColumns: "0.8fr 1fr 1.2fr 1fr 1.2fr 0.9fr 0.7fr 0.9fr",
                padding: "8px 18px",
                borderBottom: "1px solid var(--line-soft)",
                fontSize: 11.5,
                color: "var(--fg-4)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              <span>Time</span>
              <span>Team</span>
              <span>Project</span>
              <span>Provider</span>
              <span>Model</span>
              <span>Tokens</span>
              <span>Latency</span>
              <span style={{ textAlign: "right" }}>Status</span>
            </div>

            {loading && (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>Loading requests…</div>
            )}

            {!loading && loadError && (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--red)", fontSize: 13.5 }}>
                Couldn&apos;t load requests.
              </div>
            )}

            {!loading && !loadError && rows.length === 0 && (
              <div style={{ padding: "40px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 15, color: "var(--fg-2)", marginBottom: 8 }}>
                  No requests logged yet for this workspace and filters
                </div>
                <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 500, margin: "0 auto 16px" }}>
                  Send an AI request through the gateway using your virtual key to see request logs and token metering.
                </p>
                <Link href="/onboarding" className="btn btn-violet btn-sm">
                  Send Test Request →
                </Link>
              </div>
            )}

            {rows.map((r, i) => (
              <Fragment key={r.id}>
                <div
                  onClick={() => setOpenId(openId === r.id ? null : r.id)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "0.8fr 1fr 1.2fr 1fr 1.2fr 0.9fr 0.7fr 0.9fr",
                    padding: "12px 18px",
                    borderBottom: openId === r.id || i < rows.length - 1 ? "1px solid var(--line-soft)" : "none",
                    alignItems: "center",
                    cursor: "pointer",
                    background: openId === r.id ? "var(--bg-2)" : "transparent",
                  }}
                >
                  <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-4)" }}>
                    {r.ts}
                  </span>
                  <span className="mono" style={{ fontSize: 13.5, color: "var(--fg-1)" }}>
                    {r.team}
                  </span>
                  <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
                    {r.project}
                  </span>
                  <span className="mono" style={{ fontSize: 13, color: "var(--fg-2)" }}>
                    {r.provider}
                  </span>
                  <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>
                    {r.model}
                  </span>
                  <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
                    {((r.tokensIn || 0) + (r.tokensOut || 0)).toLocaleString()}
                  </span>
                  <span className="mono" style={{ fontSize: 12.5, color: r.latencyMs > 1000 ? "var(--amber)" : "var(--fg-3)" }}>
                    {r.latencyMs}ms
                  </span>
                  <div style={{ textAlign: "right" }}>
                    <StatusPill status={r.status === "success" ? "ok" : r.status === "error" ? "breached" : "warning"} />
                  </div>
                </div>
                {openId === r.id && (
                  <div
                    style={{
                      padding: "16px 18px",
                      borderBottom: i < rows.length - 1 ? "1px solid var(--line-soft)" : "none",
                      background: "var(--bg-2)",
                    }}
                  >
                    <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)", letterSpacing: "0.05em", marginBottom: 10 }}>
                      REQUEST {r.id}
                    </div>
                    <div className="mobile-stack" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
                      <Field label="Input tokens" value={Number(r.tokensIn || 0).toLocaleString()} />
                      <Field label="Output tokens" value={Number(r.tokensOut || 0).toLocaleString()} />
                      <Field label="Cost" value={`$${Number(r.cost || 0).toFixed(5)}`} />
                      <Field label="Status" value={r.status} />
                    </div>
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)", letterSpacing: "0.04em" }}>
        {label.toUpperCase()}
      </div>
      <div className="mono" style={{ fontSize: 14, color: "var(--fg-1)", marginTop: 3 }}>
        {value}
      </div>
    </div>
  );
}
