"use client";

import { useEffect, useState } from "react";
import { StatusPill } from "@/components/StatusBadges";
import { StateNote, useGateway } from "@/lib/useGateway";

type Repo = {
  id: string; name: string; branch: string | null; commit_sha: string | null; last_synced_at: string;
  sessions: number; memories: number; graph_stats: { files?: number; nodes?: Record<string, number>; edges?: Record<string, number> } | null;
};
type Session = {
  agent: string; session_id: string; branch: string | null; state: string; started_at: string; last_event_at: string;
  models: string[] | null; tokens: { total?: number; requests?: number } | null; cost_usd: number | null; cost_source: string | null;
  counts: { filesModified?: number; filesCreated?: number; testsPassed?: number; testsFailed?: number; errors?: number } | null;
  repository_id: string; repository: string;
};
type Memory = { key: string; category: string; content: string; source_kind: string; status: string; updated_at: string };
type Graph = { modules: { name: string; path: string; files: number }[] };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
const num = (n: number | undefined) => (n ?? 0).toLocaleString();
const sum = (o?: Record<string, number>) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
type Tab = "sessions" | "memories" | "graph";

export default function AgentActivityPage() {
  const repos = useGateway<Repo[]>("repositories");
  const [repoId, setRepoId] = useState<string>("");
  const [tab, setTab] = useState<Tab>("sessions");

  const list = repos.data ?? [];
  useEffect(() => { if (!repoId && list.length) setRepoId(list[0].id); }, [list, repoId]);
  const repo = list.find((r) => r.id === repoId);

  const sessions = useGateway<Session[]>(repoId ? `agent-sessions?repository=${repoId}&limit=100` : "repositories");
  const memories = useGateway<Memory[]>(repoId ? `repositories/${repoId}/memories` : "repositories");
  const graph = useGateway<Graph>(repoId ? `repositories/${repoId}/graph` : "repositories");

  if (repos.loading || repos.error || list.length === 0) {
    return <StateNote loading={repos.loading} error={repos.error} empty="Nothing synced yet. In a repository run `tokenistt sync --dry-run`, then `tokenistt sync --enable`." />;
  }

  const byCategory = new Map<string, Memory[]>();
  for (const m of (memories.data as Memory[] | null) ?? []) byCategory.set(m.category, [...(byCategory.get(m.category) ?? []), m]);

  return (
    <div>
      <div className="dash-section-head"><div className="mono dash-section-label">REPOSITORIES · {list.length}</div></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, marginBottom: 24 }}>
        {list.map((r) => (
          <button key={r.id} type="button" className="card" onClick={() => setRepoId(r.id)}
            style={{ padding: 16, textAlign: "left", cursor: "pointer", borderColor: r.id === repoId ? "var(--violet)" : undefined }}>
            <div style={{ fontSize: 15, color: "var(--fg)" }}>{r.name}</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 3 }}>{r.branch ?? "no branch"} · {r.commit_sha?.slice(0, 7) ?? "no commit"}</div>
            <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 10 }}>
              {r.sessions} sessions · {r.memories} memories · {num(r.graph_stats?.files)} files · {num(sum(r.graph_stats?.nodes))} nodes
            </div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)", marginTop: 4 }}>synced {when(r.last_synced_at)}</div>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["sessions", "memories", "graph"] as Tab[]).map((t) => (
          <button key={t} type="button" className={t === tab ? "btn btn-violet btn-sm" : "btn btn-ghost btn-sm"} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "sessions" && (
        <>
          <StateNote loading={sessions.loading} error={sessions.error} empty={!sessions.loading && !sessions.error && !(sessions.data as Session[] | null)?.length ? "No sessions synced for this repository." : undefined} />
          {((sessions.data as Session[] | null) ?? []).length > 0 && (
            <div className="card" style={{ overflow: "hidden" }}>
              {(sessions.data as Session[]).map((s, i, a) => (
                <div key={s.agent + s.session_id} style={{ padding: "14px 18px", borderBottom: i < a.length - 1 ? "1px solid var(--line-soft)" : "none", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontSize: 14.5, color: "var(--fg)" }}>{s.agent}</div>
                    <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 3 }}>{s.branch ?? "no branch"} · {(s.models ?? []).join(", ") || "model unknown"}</div>
                  </div>
                  <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
                    {num(s.tokens?.total)} tokens · {s.cost_usd == null ? "cost unknown" : `$${s.cost_usd.toFixed(2)}`}
                  </span>
                  <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
                    {num((s.counts?.filesModified ?? 0) + (s.counts?.filesCreated ?? 0))} files · tests {num(s.counts?.testsPassed)}✓ {num(s.counts?.testsFailed)}✗
                  </span>
                  <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)", minWidth: 150 }}>{when(s.last_event_at)}</span>
                  <StatusPill status={s.state === "active" ? "active" : "revoked"} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "memories" && (
        <>
          <StateNote loading={memories.loading} error={memories.error} empty={!memories.loading && !memories.error && byCategory.size === 0 ? "No memories synced for this repository." : undefined} />
          {[...byCategory.entries()].map(([cat, items]) => (
            <div key={cat} style={{ marginBottom: 20 }}>
              <div className="mono dash-section-label" style={{ marginBottom: 8 }}>{cat.replace(/_/g, " ")} · {items.length}</div>
              <div className="card" style={{ overflow: "hidden" }}>
                {items.map((m, i) => (
                  <div key={m.key} style={{ padding: "12px 18px", borderBottom: i < items.length - 1 ? "1px solid var(--line-soft)" : "none", opacity: m.status === "stale" ? 0.6 : 1 }}>
                    <div style={{ fontSize: 13.5, color: "var(--fg-2)" }}>{m.content}</div>
                    <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)", marginTop: 4 }}>{m.source_kind} · {m.status} · {when(m.updated_at)}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {tab === "graph" && repo && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, marginBottom: 20 }}>
            {[["Nodes", repo.graph_stats?.nodes], ["Edges", repo.graph_stats?.edges]].map(([label, o]) => (
              <div key={label as string} className="card" style={{ padding: 16 }}>
                <div className="mono" style={{ fontSize: 11, color: "var(--fg-4)" }}>{(label as string).toUpperCase()}</div>
                <div style={{ fontSize: 22, color: "var(--fg)", margin: "4px 0 8px" }}>{num(sum(o as Record<string, number>))}</div>
                <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.7 }}>
                  {Object.entries((o as Record<string, number>) ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k.toLowerCase()} ${num(v)}`).join(" · ")}
                </div>
              </div>
            ))}
          </div>
          <StateNote loading={graph.loading} error={graph.error} />
          {((graph.data as Graph | null)?.modules ?? []).length > 0 && (
            <>
              <div className="mono dash-section-label" style={{ marginBottom: 8 }}>MODULES · {(graph.data as Graph).modules.length}</div>
              <div className="card" style={{ overflow: "hidden" }}>
                {(graph.data as Graph).modules.map((m, i, a) => (
                  <div key={m.path + m.name} style={{ padding: "12px 18px", display: "flex", gap: 16, borderBottom: i < a.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
                    <span style={{ flex: 1, fontSize: 14, color: "var(--fg)" }}>{m.name}</span>
                    <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>{m.path}</span>
                    <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)", minWidth: 70, textAlign: "right" }}>{num(m.files)} files</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
