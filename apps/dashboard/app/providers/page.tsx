"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useDashboard } from "@/components/DashboardShell";
import { getProviderBreakdown } from "@/lib/mock-data";
import { LogoBadge } from "@/components/StatusBadges";
import { fmtUsd, fmtUsdCompact } from "@/lib/format";

export default function ProvidersPage() {
  const { isLive } = useDashboard();
  const [liveData, setLiveData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isLive) return;
    let mounted = true;
    setLoading(true);

    fetch("/api/providers")
      .then((res) => (res.ok ? res.json() : []))
      .then((items) => {
        if (mounted && Array.isArray(items)) {
          setLiveData(items);
        }
      })
      .catch((err) => {
        console.warn("Could not load /api/providers:", err);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [isLive]);

  const data = isLive ? liveData : getProviderBreakdown();
  const total = data.reduce((s: number, d: any) => s + (Number(d.spendUsd) || 0), 0);

  return (
    <div>
      <div className="dash-section-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <div className="mono dash-section-label">CONNECTED · {data.length}</div>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>
            Consolidated spend by AI provider (month to date)
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="mono" style={{ fontSize: 13, color: "var(--fg-3)" }}>
            {fmtUsdCompact(total)} total
          </span>
          <Link href="/onboarding" className="btn btn-violet btn-sm">
            + Connect Provider
          </Link>
        </div>
      </div>

      {data.length === 0 ? (
        <div className="card" style={{ padding: "48px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 15, color: "var(--fg-2)", marginBottom: 8 }}>
            No provider usage recorded yet
          </div>
          <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 480, margin: "0 auto 16px" }}>
            Add your upstream provider keys (OpenAI, Anthropic, Mistral) in Settings or follow Onboarding to generate a virtual key.
          </p>
          <Link href="/onboarding" className="btn btn-violet btn-sm">
            Connect First Provider →
          </Link>
        </div>
      ) : (
        <div className="integration-grid">
          {data.map((d: any) => (
            <div key={d.provider} className="card integration-card">
              <div className="integration-card-head">
                <LogoBadge letter={d.label.charAt(0)} color={d.color} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 15.5, color: "var(--fg)" }}>{d.label}</div>
                  <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>
                    {(d.sharePct ?? 0).toFixed(1)}% of spend
                  </div>
                </div>
              </div>
              <div className="integration-card-stats">
                <div>
                  <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)", letterSpacing: "0.04em" }}>
                    SPEND MTD
                  </div>
                  <div className="mono" style={{ fontSize: 16, color: "var(--fg)" }}>
                    {fmtUsd(d.spendUsd ?? 0)}
                  </div>
                </div>
                <div>
                  <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)", letterSpacing: "0.04em" }}>
                    SHARE OF SPEND
                  </div>
                  <div className="mono" style={{ fontSize: 16, color: "var(--fg)" }}>
                    {(d.sharePct ?? 0).toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
