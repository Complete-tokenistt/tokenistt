"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useDashboard } from "@/components/DashboardShell";
import { Sparkline } from "@/components/Sparkline";
import { FEATURE_ATTRIBUTION, TAG_COVERAGE } from "@/lib/dashboard-mock-data";

export default function CostAttributionPage() {
  const { isLive } = useDashboard();
  const [liveSeries, setLiveSeries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isLive) return;
    let mounted = true;
    setLoading(true);

    fetch("/api/explorer?groupBy=project_tag")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (mounted && data?.series) {
          setLiveSeries(data.series);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [isLive]);

  // Compute coverage and features based on mode
  const totalSpend = isLive
    ? liveSeries.reduce((acc, s) => acc + (s.cost || 0), 0)
    : TAG_COVERAGE.totalSpend;

  const untaggedSpend = isLive
    ? liveSeries.filter((s) => s.label === "untagged").reduce((acc, s) => acc + (s.cost || 0), 0)
    : TAG_COVERAGE.untaggedSpend;

  const taggedSpend = totalSpend - untaggedSpend;
  const taggedPct = totalSpend > 0 ? Math.round((taggedSpend / totalSpend) * 100) : 0;

  const featuresToRender = isLive
    ? liveSeries.map((s) => ({
        feature: s.label,
        team: "General",
        spend: Math.round((s.cost || 0) * 100) / 100,
        taggedPct: s.label === "untagged" ? 0 : 100,
        trend: [s.cost * 0.8, s.cost * 0.9, s.cost],
      }))
    : FEATURE_ATTRIBUTION;

  const maxSpend = Math.max(1, ...featuresToRender.map((f) => f.spend));

  return (
    <div>
      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
          <div>
            <div className="mono dash-section-label">TAGGING COVERAGE</div>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>
              Attribution accuracy depends on your own instrumentation
            </div>
          </div>
          <span className="mono" style={{ fontSize: 20, color: taggedPct > 85 ? "var(--green)" : "var(--amber)" }}>
            {taggedPct}% tagged
          </span>
        </div>
        <div style={{ height: 10, borderRadius: 2, overflow: "hidden", border: "1px solid var(--line-soft)", display: "flex" }}>
          <div style={{ flex: Math.max(1, taggedPct), background: "var(--violet)" }} />
          <div style={{ flex: Math.max(1, 100 - taggedPct), background: "var(--bg-3)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }} className="mono">
          <span style={{ fontSize: 12, color: "var(--fg-3)" }}>
            ${taggedSpend.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} attributed
          </span>
          <span style={{ fontSize: 12, color: "var(--amber)" }}>
            ${untaggedSpend.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} untagged
          </span>
        </div>
        <div style={{ marginTop: 14, padding: "10px 14px", background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 6, fontSize: 13.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
          Add a <code className="mono" style={{ color: "var(--violet)" }}>feature_tag</code> or <code className="mono" style={{ color: "var(--violet)" }}>x-project-tag</code> header to gateway requests to attribute spend to specific product initiatives.
        </div>
      </div>

      <div className="dash-section-head">
        <div>
          <div className="mono dash-section-label">SPEND BY FEATURE</div>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>
            Not just team — the actual product surface driving cost
          </div>
        </div>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        {featuresToRender.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginBottom: 8 }}>
              No feature attribution data recorded yet
            </div>
            <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 480, margin: "0 auto 16px" }}>
              Include the <code className="mono" style={{ color: "var(--violet)" }}>x-project-tag</code> header in requests to attribute costs to features like search, onboarding, or summarization.
            </p>
            <Link href="/onboarding" className="btn btn-ghost btn-sm mono">
              Integration Docs →
            </Link>
          </div>
        ) : (
          featuresToRender.map((f, i) => (
            <div
              key={f.feature}
              style={{
                display: "grid",
                gridTemplateColumns: "1.6fr 1fr 0.9fr 1fr",
                gap: 14,
                alignItems: "center",
                padding: "14px 18px",
                borderBottom: i < featuresToRender.length - 1 ? "1px solid var(--line-soft)" : "none",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 14.5,
                    color: f.feature.startsWith("untagged") ? "var(--fg-3)" : "var(--fg)",
                    fontStyle: f.feature.startsWith("untagged") ? "italic" : "normal",
                  }}
                >
                  {f.feature}
                </div>
                <div className="mono" style={{ fontSize: 12, color: "var(--fg-4)", marginTop: 3 }}>
                  {f.team}
                </div>
              </div>
              <div>
                <div style={{ height: 6, background: "var(--bg-2)", borderRadius: 1, overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${(f.spend / maxSpend) * 100}%`,
                      height: "100%",
                      background: f.feature.startsWith("untagged") ? "var(--fg-4)" : "var(--violet)",
                    }}
                  />
                </div>
                <span className="mono" style={{ fontSize: 12.5, color: "var(--fg-2)", marginTop: 5, display: "block" }}>
                  ${f.spend.toLocaleString()}
                </span>
              </div>
              <span
                className="mono"
                style={{
                  fontSize: 12.5,
                  color: f.taggedPct === 0 ? "var(--fg-4)" : f.taggedPct < 80 ? "var(--amber)" : "var(--fg-2)",
                }}
              >
                {f.taggedPct === 0 ? "—" : `${f.taggedPct}% tagged`}
              </span>
              <Sparkline data={f.trend} width={130} height={26} stroke="var(--violet)" showFill={false} showDot={false} pad={2} strokeWidth={1.2} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
