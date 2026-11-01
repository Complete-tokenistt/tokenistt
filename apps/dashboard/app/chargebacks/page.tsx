"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useDashboard } from "@/components/DashboardShell";
import { StatusPill } from "@/components/StatusBadges";

function downloadCsv(filename: string, header: string, rows: string[]) {
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ChargebacksPage() {
  const { notify } = useDashboard();
  const [ledger, setLedger] = useState<any[]>([]);
  const [history, setHistory] = useState<{ period: string; total: number; status: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetch("/api/chargebacks?period=month")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!mounted) return;
        if (!data) setLoadError(true);
        setLedger(data?.ledger || []);
        setHistory(Array.isArray(data?.history) ? data.history : []);
      })
      .catch(() => {
        if (mounted) setLoadError(true);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const total = ledger.reduce((a, r) => a + (r.spend || 0), 0);
  const historyToRender = history;

  function exportCsv() {
    downloadCsv(
      "tokenistt-chargebacks.csv",
      "cost_center,team,period,spend_usd",
      ledger.map((r) => [`"${r.costCenter}"`, r.team, `"${r.period}"`, r.spend].join(","))
    );
    notify("Chargeback ledger exported");
  }

  function downloadHistorical(period: string) {
    downloadCsv(
      `tokenistt-chargebacks-${period.toLowerCase().replace(" ", "-")}.csv`,
      "period,total_usd",
      [`"${period}",${history.find((h) => h.period === period)?.total ?? 0}`]
    );
    notify(`${period} report downloaded`);
  }

  function updateCostCenter(team: string, value: string) {
    setLedger((l) => l.map((r) => (r.team === team ? { ...r, costCenter: value } : r)));
  }

  function saveMapping() {
    setEditing(false);
    notify("Cost-center mapping saved");
  }

  return (
    <div>
      <div className="card" style={{ overflow: "hidden", marginBottom: 24 }}>
        <div
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid var(--line-soft)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "var(--bg-2)",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>
            billing-period ledger · {new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={ledger.length === 0}>
              ↓ Export CSV
            </button>
            {ledger.length > 0 && (
              editing ? (
                <button type="button" className="btn btn-violet btn-sm" onClick={saveMapping}>
                  Save mapping
                </button>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
                  Edit cost-center mapping
                </button>
              )
            )}
          </div>
        </div>
        <div className="data-table-wrap">
          <div style={{ minWidth: 560 }}>
            <div
              className="mono"
              style={{
                display: "grid",
                gridTemplateColumns: "1.6fr 1fr 1fr 0.9fr",
                padding: "8px 18px",
                borderBottom: "1px solid var(--line-soft)",
                fontSize: 11.5,
                color: "var(--fg-4)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              <span>Cost center</span>
              <span>Team</span>
              <span>Period</span>
              <span style={{ textAlign: "right" }}>Spend</span>
            </div>

            {loading && (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>Loading ledger…</div>
            )}

            {!loading && loadError && (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--red)", fontSize: 13.5 }}>
                Couldn&apos;t load the chargeback ledger.
              </div>
            )}

            {!loading && !loadError && ledger.length === 0 && (
              <div style={{ padding: "40px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 15, color: "var(--fg-2)", marginBottom: 8 }}>
                  No chargeback entries for the current billing period
                </div>
                <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 480, margin: "0 auto 16px" }}>
                  Cost center allocations will automatically settle here once transactions with the <code className="mono" style={{ color: "var(--violet)" }}>x-cost-center</code> header are logged.
                </p>
                <Link href="/onboarding" className="btn btn-ghost btn-sm mono">
                  View Attribution Guide →
                </Link>
              </div>
            )}

            {ledger.map((r, i) => (
              <div
                key={r.team || i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.6fr 1fr 1fr 0.9fr",
                  padding: "13px 18px",
                  borderBottom: i < ledger.length - 1 ? "1px solid var(--line-soft)" : "none",
                  alignItems: "center",
                }}
              >
                {editing ? (
                  <input
                    className="mono dash-input"
                    value={r.costCenter}
                    onChange={(e) => updateCostCenter(r.team, e.target.value)}
                    style={{ maxWidth: 260 }}
                  />
                ) : (
                  <span style={{ fontSize: 14, color: "var(--fg)" }}>{r.costCenter}</span>
                )}
                <span className="mono" style={{ fontSize: 13, color: "var(--fg-2)" }}>
                  {r.team}
                </span>
                <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
                  {r.period}
                </span>
                <span className="mono" style={{ fontSize: 14, color: "var(--fg-1)", textAlign: "right" }}>
                  ${Number(r.spend).toFixed(2)}
                </span>
              </div>
            ))}
            {ledger.length > 0 && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.6fr 1fr 1fr 0.9fr",
                  padding: "13px 18px",
                  background: "var(--bg-2)",
                }}
              >
                <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
                  TOTAL
                </span>
                <span />
                <span />
                <span className="mono" style={{ fontSize: 15, color: "var(--violet)", textAlign: "right" }}>
                  ${total.toFixed(2)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="dash-section-head">
        <div>
          <div className="mono dash-section-label">HISTORICAL REPORTS</div>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Month over month, exportable</div>
        </div>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        {historyToRender.length === 0 ? (
          <div style={{ padding: "24px 18px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>
            No closed historical billing periods yet. Reports become available at the close of each month.
          </div>
        ) : (
          historyToRender.map((r, i) => (
            <div
              key={r.period}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "13px 18px",
                borderBottom: i < historyToRender.length - 1 ? "1px solid var(--line-soft)" : "none",
              }}
            >
              <span className="mono" style={{ fontSize: 14, color: "var(--fg)", flex: 1 }}>
                {r.period}
              </span>
              <span className="mono" style={{ fontSize: 13.5, color: "var(--fg-2)" }}>
                ${r.total.toLocaleString()}
              </span>
              <StatusPill status={r.status === "closed" ? "ok" : "warning"} />
              <button type="button" className="mono dash-link-btn" onClick={() => downloadHistorical(r.period)}>
                download
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
