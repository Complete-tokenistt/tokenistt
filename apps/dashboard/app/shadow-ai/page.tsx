"use client";

import { useEffect, useState } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { getShadowAi } from "@/lib/mock-data";
import Section from "@/components/Section";
import ShadowAiTable from "@/components/ShadowAiTable";
import StatCard from "@/components/StatCard";
import { fmtUsd } from "@/lib/format";
import type { ShadowAiEvent } from "@/lib/types";

export default function ShadowAiPage() {
  const { isLive } = useDashboard();
  const [liveData, setLiveData] = useState<ShadowAiEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isLive) return;
    let mounted = true;
    setLoading(true);

    fetch("/api/shadow-ai")
      .then((res) => (res.ok ? res.json() : []))
      .then((items) => {
        if (mounted && Array.isArray(items)) {
          setLiveData(items);
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

  const demoData = getShadowAi();
  const data = isLive ? liveData : demoData;
  const total = data.reduce((s, e) => s + e.amountUsd, 0);
  const unreviewed = data.filter((e) => e.status === "unreviewed").length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Detected spend" value={fmtUsd(total)} accent={total > 0 ? "amber" : "brand"} />
        <StatCard label="Events" value={String(data.length)} accent="brand" />
        <StatCard label="Unreviewed" value={String(unreviewed)} accent={unreviewed > 0 ? "red" : "emerald"} />
      </div>

      <Section
        title="Shadow AI — unauthorized usage"
        description="Surfaced from corporate cards, browser extensions, and expense integrations outside the Tokenistt gateway"
      >
        {data.length === 0 ? (
          <div className="card" style={{ padding: "36px 20px", textAlign: "center" }}>
            <div style={{ color: "#22c55e", fontSize: 24, marginBottom: 8 }}>✓</div>
            <div style={{ fontSize: 15, color: "var(--fg)", marginBottom: 6 }}>
              No unauthorized shadow AI activity detected
            </div>
            <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 520, margin: "0 auto" }}>
              All AI model calls are properly routed, attributed, and enforced through your Tokenistt gateway policies.
            </p>
          </div>
        ) : (
          <ShadowAiTable data={data} />
        )}
      </Section>
    </div>
  );
}
