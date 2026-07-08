import Link from "next/link";
import { getSummary, getAnomalies, getProviderBreakdown } from "@/lib/mock-data";
import { Kpi } from "@/components/Kpi";
import { LogoBadge, StatusPill } from "@/components/StatusBadges";
import { fmtUsd, fmtPct } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const s = await getSummary();
  const anomalies = await getAnomalies();
  const providers = await getProviderBreakdown();

  const budgetTone = s.budgetUsedPct >= 100 ? "breached" : s.budgetUsedPct >= 85 ? "warning" : null;

  return (
    <div>
      {budgetTone && (
        <div className="dash-section">
          <div
            className="dash-alert-banner"
            style={budgetTone === "breached" ? { background: "oklch(0.577 0.245 27 / 0.10)", borderColor: "oklch(0.577 0.245 27 / 0.35)" } : undefined}
          >
            <span
              className="mono dash-alert-tag"
              style={budgetTone === "breached" ? { color: "var(--red)", borderColor: "oklch(0.577 0.245 27 / 0.45)" } : undefined}
            >
              {budgetTone === "breached" ? "BREACHED" : "WARNING"}
            </span>
            <span style={{ fontSize: 14.5, color: "var(--fg-1)" }}>
              Workspace is at <strong>{s.budgetUsedPct.toFixed(1)}%</strong> of its {fmtUsd(s.budgetUsd)} monthly cap
            </span>
            <Link href="/budgets" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }}>Review →</Link>
          </div>
        </div>
      )}

      <div className="card dash-kpi-grid" style={{ marginBottom: 24 }}>
        <Kpi label="Spend MTD" value={<><span className="violet">$</span>{s.totalSpendUsd.toLocaleString()}</>} sub={`${fmtPct(s.momGrowthPct)} vs last month`} accent />
        <Kpi label="Budget utilization" value={`${s.budgetUsedPct.toFixed(1)}%`} sub={`${fmtUsd(s.totalSpendUsd)} / ${fmtUsd(s.budgetUsd)} cap`} />
        <Kpi label="Anomaly alerts" value={String(s.anomalyCount)} sub=">3× 30-day average" />
        <Kpi label="Shadow AI exposure" value={fmtUsd(s.shadowAiSpendUsd)} sub={`${s.shadowAiCount} unreviewed events`} style={{ borderRight: "none" }} />
      </div>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <div className="mono dash-section-label">TOP COST CENTERS</div>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Share of {fmtUsd(s.totalSpendUsd)} MTD spend</div>
          </div>
          <Link href="/cost-centers" className="btn btn-ghost btn-sm">View all →</Link>
        </div>
        <div className="card" style={{ padding: 20 }}>
          {s.topCostCenters.map((c) => (
            <div key={c.code} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 6 }}>
                <span style={{ color: "var(--fg)" }}>{c.name} <span className="mono" style={{ fontSize: 12, color: "var(--fg-4)" }}>{c.code}</span></span>
                <span className="mono" style={{ color: "var(--fg-2)" }}>{fmtUsd(c.spendUsd)} · {c.sharePct.toFixed(1)}%</span>
              </div>
              <div style={{ height: 6, background: "var(--bg-2)", borderRadius: 1, overflow: "hidden" }}>
                <div style={{ width: `${c.sharePct}%`, height: "100%", background: "var(--violet)" }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <div className="mono dash-section-label">ANOMALY ALERTS</div>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Spend spikes vs 30-day baseline</div>
          </div>
        </div>
        <div className="card" style={{ overflow: "hidden" }}>
          {anomalies.map((a, i) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 18px", borderBottom: i < anomalies.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
              <StatusPill status={a.severity === "high" ? "breached" : "warning"} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 14, color: "var(--fg)" }}>{a.actor}</span>
                <span className="mono" style={{ fontSize: 12, color: "var(--fg-4)", marginLeft: 8 }}>{a.costCenter}</span>
              </div>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--red)" }}>{a.ratio.toFixed(1)}× · {fmtUsd(a.spend24hUsd)}/24h</span>
            </div>
          ))}
        </div>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <div className="mono dash-section-label">CONNECTED PROVIDERS</div>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>{fmtUsd(s.totalSpendUsd)} spent this cycle across {providers.length} providers</div>
          </div>
          <Link href="/providers" className="btn btn-ghost btn-sm">Manage providers →</Link>
        </div>
        <div className="dash-provider-strip">
          {providers.map((p) => (
            <div key={p.provider} className="dash-provider-chip">
              <LogoBadge letter={p.label.charAt(0)} color={p.color} size={28} radius={7} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.label}</div>
                <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>{p.sharePct.toFixed(1)}%</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <div className="mono dash-section-label">QUICK ACTIONS</div>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Common next steps for a new workspace</div>
          </div>
        </div>
        <div className="dash-quick-grid">
          <Link href="/onboarding" className="card dash-quick-card">
            <div className="mono dash-quick-num">01</div>
            <div style={{ fontSize: 15.5, color: "var(--fg)", marginTop: 8 }}>Connect your first provider</div>
            <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.5 }}>Route Anthropic or OpenAI traffic through the gateway.</p>
          </Link>
          <Link href="/budgets" className="card dash-quick-card">
            <div className="mono dash-quick-num">02</div>
            <div style={{ fontSize: 15.5, color: "var(--fg)", marginTop: 8 }}>Set a team budget cap</div>
            <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.5 }}>Alert or auto-throttle before a team overspends.</p>
          </Link>
          <Link href="/governance" className="card dash-quick-card">
            <div className="mono dash-quick-num">03</div>
            <div style={{ fontSize: 15.5, color: "var(--fg)", marginTop: 8 }}>Write a governance policy</div>
            <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.5 }}>Control which models a team can call, and prove it later.</p>
          </Link>
          <Link href="/settings" className="card dash-quick-card">
            <div className="mono dash-quick-num">04</div>
            <div style={{ fontSize: 15.5, color: "var(--fg)", marginTop: 8 }}>Secure your credentials</div>
            <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.5 }}>Encrypt and manage the root API keys the gateway uses.</p>
          </Link>
        </div>
      </section>
    </div>
  );
}
