import { Sparkline } from "@/components/Sparkline";
import { FEATURE_ATTRIBUTION, TAG_COVERAGE } from "@/lib/dashboard-mock-data";

export default function CostAttributionPage() {
  const maxSpend = Math.max(...FEATURE_ATTRIBUTION.map((f) => f.spend));

  return (
    <div>
      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
          <div>
            <div className="mono dash-section-label">TAGGING COVERAGE</div>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Attribution accuracy depends on your own instrumentation</div>
          </div>
          <span className="mono" style={{ fontSize: 20, color: TAG_COVERAGE.taggedPct > 85 ? "var(--green)" : "var(--amber)" }}>{TAG_COVERAGE.taggedPct}% tagged</span>
        </div>
        <div style={{ height: 10, borderRadius: 2, overflow: "hidden", border: "1px solid var(--line-soft)", display: "flex" }}>
          <div style={{ flex: TAG_COVERAGE.taggedPct, background: "var(--violet)" }} />
          <div style={{ flex: 100 - TAG_COVERAGE.taggedPct, background: "var(--bg-3)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }} className="mono">
          <span style={{ fontSize: 12, color: "var(--fg-3)" }}>${(TAG_COVERAGE.totalSpend - TAG_COVERAGE.untaggedSpend).toLocaleString()} attributed</span>
          <span style={{ fontSize: 12, color: "var(--amber)" }}>${TAG_COVERAGE.untaggedSpend.toLocaleString()} untagged</span>
        </div>
        <div style={{ marginTop: 14, padding: "10px 14px", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 6, fontSize: 13.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
          Add a <code className="mono" style={{ color: "var(--violet)" }}>feature_tag</code> header to gateway requests to attribute spend. Untagged requests still show up in Usage, but roll into &quot;unattributed&quot; here.
        </div>
      </div>

      <div className="dash-section-head">
        <div>
          <div className="mono dash-section-label">SPEND BY FEATURE</div>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Not just team — the actual product surface driving cost</div>
        </div>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        {FEATURE_ATTRIBUTION.map((f, i) => (
          <div key={f.feature} style={{
            display: "grid", gridTemplateColumns: "1.6fr 1fr 0.9fr 1fr", gap: 14, alignItems: "center",
            padding: "14px 18px", borderBottom: i < FEATURE_ATTRIBUTION.length - 1 ? "1px solid var(--line-soft)" : "none",
          }}>
            <div>
              <div style={{ fontSize: 14.5, color: f.feature.startsWith("untagged") ? "var(--fg-3)" : "var(--fg)", fontStyle: f.feature.startsWith("untagged") ? "italic" : "normal" }}>{f.feature}</div>
              <div className="mono" style={{ fontSize: 12, color: "var(--fg-4)", marginTop: 3 }}>{f.team}</div>
            </div>
            <div>
              <div style={{ height: 6, background: "var(--bg-2)", borderRadius: 1, overflow: "hidden" }}>
                <div style={{ width: `${(f.spend / maxSpend) * 100}%`, height: "100%", background: f.feature.startsWith("untagged") ? "var(--fg-4)" : "var(--violet)" }} />
              </div>
              <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)", marginTop: 5, display: "block" }}>${f.spend.toLocaleString()}</span>
            </div>
            <span className="mono" style={{ fontSize: 12.5, color: f.taggedPct === 0 ? "var(--fg-4)" : f.taggedPct < 80 ? "var(--amber)" : "var(--fg-2)" }}>
              {f.taggedPct === 0 ? "—" : `${f.taggedPct}% tagged`}
            </span>
            <Sparkline data={f.trend} width={130} height={26} stroke="var(--violet)" showFill={false} showDot={false} pad={2} strokeWidth={1.2} />
          </div>
        ))}
      </div>
    </div>
  );
}
