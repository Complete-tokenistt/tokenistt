import { getProviderBreakdown } from "@/lib/mock-data";
import { LogoBadge } from "@/components/StatusBadges";
import { fmtUsd, fmtUsdCompact } from "@/lib/format";

export default function ProvidersPage() {
  const data = getProviderBreakdown();
  const total = data.reduce((s, d) => s + d.spendUsd, 0);

  return (
    <div>
      <div className="dash-section-head">
        <div>
          <div className="mono dash-section-label">CONNECTED · {data.length}</div>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Consolidated spend by AI provider (month to date)</div>
        </div>
        <span className="mono" style={{ fontSize: 13, color: "var(--fg-3)" }}>{fmtUsdCompact(total)} total</span>
      </div>

      <div className="integration-grid">
        {data.map((d) => (
          <div key={d.provider} className="card integration-card">
            <div className="integration-card-head">
              <LogoBadge letter={d.label.charAt(0)} color={d.color} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 15.5, color: "var(--fg)" }}>{d.label}</div>
                <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>{d.sharePct.toFixed(1)}% of spend</div>
              </div>
            </div>
            <div className="integration-card-stats">
              <div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)", letterSpacing: "0.04em" }}>SPEND MTD</div>
                <div className="mono" style={{ fontSize: 16, color: "var(--fg)" }}>{fmtUsd(d.spendUsd)}</div>
              </div>
              <div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)", letterSpacing: "0.04em" }}>SHARE OF SPEND</div>
                <div className="mono" style={{ fontSize: 16, color: "var(--fg)" }}>{d.sharePct.toFixed(1)}%</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
