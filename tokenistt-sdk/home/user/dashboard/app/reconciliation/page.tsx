"use client";

import { useEffect, useState } from "react";
import { useDashboard } from "@/components/DashboardShell";
import { getInvoices, reconcile } from "@/lib/mock-data";
import Section from "@/components/Section";
import ReconciliationView from "@/components/ReconciliationView";
import type { ReconciliationRow } from "@/lib/types";

export default function ReconciliationPage() {
  const { isLive } = useDashboard();
  const [liveRows, setLiveRows] = useState<ReconciliationRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isLive) return;
    let mounted = true;
    setLoading(true);

    fetch("/api/reconciliation")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (mounted && Array.isArray(data?.rows)) {
          setLiveRows(data.rows);
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

  const initialRows = isLive ? liveRows : reconcile(getInvoices());

  return (
    <div className="space-y-6">
      <Section
        title="Invoice Reconciliation"
        description={
          isLive
            ? "Match your real transaction ledger against uploaded provider invoices (CSV / PDF)"
            : "Match ledger-calculated costs against uploaded vendor invoices (sample demo dataset)"
        }
      >
        <ReconciliationView initialRows={initialRows} key={isLive ? "live" : "demo"} />
      </Section>
    </div>
  );
}
