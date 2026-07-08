"use client";

import { useState } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { StatusPill } from "@/components/StatusBadges";
import { CHARGEBACK_LEDGER, CHARGEBACK_HISTORY } from "@/lib/dashboard-mock-data";

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
  const [ledger, setLedger] = useState(CHARGEBACK_LEDGER);
  const [editing, setEditing] = useState(false);
  const total = ledger.reduce((a, r) => a + r.spend, 0);

  function exportCsv() {
    downloadCsv(
      "tokenistt-chargebacks-june-2026.csv",
      "cost_center,team,period,spend_usd",
      ledger.map((r) => [`"${r.costCenter}"`, r.team, `"${r.period}"`, r.spend].join(","))
    );
    notify("Chargeback ledger exported");
  }

  function downloadHistorical(period: string) {
    downloadCsv(`tokenistt-chargebacks-${period.toLowerCase().replace(" ", "-")}.csv`, "period,total_usd", [`"${period}",${CHARGEBACK_HISTORY.find((h) => h.period === period)?.total ?? 0}`]);
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
        <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--line-soft)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--bg-2)", flexWrap: "wrap", gap: 8 }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>billing-period ledger · June 2026 · in progress</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv}>↓ Export CSV</button>
            {editing ? (
              <button type="button" className="btn btn-violet btn-sm" onClick={saveMapping}>Save mapping</button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit cost-center mapping</button>
            )}
          </div>
        </div>
        <div className="data-table-wrap">
          <div style={{ minWidth: 560 }}>
            <div className="mono" style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 0.9fr", padding: "8px 18px", borderBottom: "1px solid var(--line-soft)", fontSize: 11.5, color: "var(--fg-4)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              <span>Cost center</span><span>Team</span><span>Period</span><span style={{ textAlign: "right" }}>Spend</span>
            </div>
            {ledger.map((r, i) => (
              <div key={r.team} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 0.9fr", padding: "13px 18px", borderBottom: i < ledger.length - 1 ? "1px solid var(--line-soft)" : "none", alignItems: "center" }}>
                {editing ? (
                  <input className="mono dash-input" value={r.costCenter} onChange={(e) => updateCostCenter(r.team, e.target.value)} style={{ maxWidth: 260 }} />
                ) : (
                  <span style={{ fontSize: 14, color: "var(--fg)" }}>{r.costCenter}</span>
                )}
                <span className="mono" style={{ fontSize: 13, color: "var(--fg-2)" }}>{r.team}</span>
                <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>{r.period}</span>
                <span className="mono" style={{ fontSize: 14, color: "var(--fg-1)", textAlign: "right" }}>${r.spend.toLocaleString()}</span>
              </div>
            ))}
            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 0.9fr", padding: "13px 18px", background: "var(--bg-2)" }}>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-3)" }}>TOTAL</span>
              <span /><span />
              <span className="mono" style={{ fontSize: 15, color: "var(--violet)", textAlign: "right" }}>${total.toLocaleString()}</span>
            </div>
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
        {CHARGEBACK_HISTORY.map((r, i) => (
          <div key={r.period} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 18px", borderBottom: i < CHARGEBACK_HISTORY.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
            <span className="mono" style={{ fontSize: 14, color: "var(--fg)", flex: 1 }}>{r.period}</span>
            <span className="mono" style={{ fontSize: 13.5, color: "var(--fg-2)" }}>${r.total.toLocaleString()}</span>
            <StatusPill status={r.status === "closed" ? "ok" : "warning"} />
            <button type="button" className="mono dash-link-btn" onClick={() => downloadHistorical(r.period)}>download</button>
          </div>
        ))}
      </div>
    </div>
  );
}
