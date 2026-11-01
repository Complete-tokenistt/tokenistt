"use client";

import { useEffect, useState } from "react";
import Section from "@/components/Section";
import ShadowAiTable from "@/components/ShadowAiTable";
import StatCard from "@/components/StatCard";
import { fmtUsd } from "@/lib/format";
import type { ShadowAiEvent } from "@/lib/types";

export default function ShadowAiPage() {
  const [liveData, setLiveData] = useState<ShadowAiEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let mounted = true;

    fetch("/api/shadow-ai")
      .then((res) => (res.ok ? res.json() : null))
      .then((items) => {
        if (!mounted) return;
        if (Array.isArray(items)) setLiveData(items);
        else setLoadError(true);
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

  const data = liveData;
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
        {loading ? (
          <div className="card" style={{ padding: "36px 20px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>Loading…</div>
        ) : loadError ? (
          <div className="card" style={{ padding: "36px 20px", textAlign: "center", color: "var(--red)", fontSize: 13.5 }}>Couldn&apos;t load shadow AI data.</div>
        ) : data.length === 0 ? (
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
