"use client";

import { useEffect, useState } from "react";
import Section from "@/components/Section";
import ReconciliationView from "@/components/ReconciliationView";
import type { ReconciliationRow } from "@/lib/types";

export default function ReconciliationPage() {
  const [liveRows, setLiveRows] = useState<ReconciliationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let mounted = true;

    fetch("/api/reconciliation")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!mounted) return;
        if (Array.isArray(data?.rows)) setLiveRows(data.rows);
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

  return (
    <div className="space-y-6">
      <Section
        title="Invoice Reconciliation"
        description="Match your real transaction ledger against uploaded provider invoices (CSV / PDF)"
      >
        {loading ? (
          <div className="card" style={{ padding: "36px 20px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>Loading ledger…</div>
        ) : (
          <>
            {loadError && (
              <div className="card" style={{ padding: 14, marginBottom: 16, color: "var(--red)", fontSize: 13.5 }}>
                Couldn&apos;t load the ledger. You can still upload an invoice to reconcile against it.
              </div>
            )}
            <ReconciliationView initialRows={liveRows} />
          </>
        )}
      </Section>
    </div>
  );
}
