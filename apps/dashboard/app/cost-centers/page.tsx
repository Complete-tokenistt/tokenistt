"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Section from "@/components/Section";
import CostCenterTable from "@/components/CostCenterTable";
import { fmtUsd } from "@/lib/format";
import type { CostCenterRow } from "@/lib/types";

export default function CostCentersPage() {
  const [liveData, setLiveData] = useState<CostCenterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let mounted = true;

    fetch("/api/cost-centers")
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
  const total = data.reduce((s, c) => s + c.spendUsd, 0);
  const growing = data.filter((c) => c.momGrowthPct > 0).length;

  return (
    <div className="space-y-6">
      <Section
        title="Cost Center Drill-down"
        description="Month-to-date spend with month-over-month growth"
        action={
          <div className="flex gap-4 text-xs mono" style={{ color: "var(--fg-4)" }}>
            <span>
              Total:{" "}
              <span className="font-semibold tabular-nums" style={{ color: "var(--fg)" }}>
                {fmtUsd(total)}
              </span>
            </span>
            <span>
              Growing:{" "}
              <span className="font-semibold tabular-nums" style={{ color: "var(--fg-2)" }}>
                {growing}/{data.length}
              </span>
            </span>
          </div>
        }
      >
        {loading ? (
          <div className="card" style={{ padding: "40px 20px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>Loading cost centers…</div>
        ) : loadError ? (
          <div className="card" style={{ padding: "40px 20px", textAlign: "center", color: "var(--red)", fontSize: 13.5 }}>Couldn&apos;t load cost centers.</div>
        ) : data.length === 0 ? (
          <div className="card" style={{ padding: "40px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginBottom: 8 }}>
              No cost center activity recorded yet
            </div>
            <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 480, margin: "0 auto 16px" }}>
              Include the <code className="mono" style={{ color: "var(--violet)" }}>x-cost-center: engineering</code> header in gateway requests to view multi-tenant spend attribution.
            </p>
            <Link href="/onboarding" className="btn btn-ghost btn-sm mono">
              View Header Integration Guide →
            </Link>
          </div>
        ) : (
          <CostCenterTable data={data} />
        )}
      </Section>
    </div>
  );
}
