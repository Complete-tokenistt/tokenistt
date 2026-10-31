"use client";

import Section from "@/components/Section";
import Badge from "@/components/Badge";
import { SimpleTable, fmtTime } from "@/components/SimpleTable";
import { StateNote, useGateway } from "@/lib/useGateway";

type Alert = { id: string; severity: "warn" | "critical" | "exceeded"; title: string; message: string; channels: string[]; created_at: string };

const TONE: Record<string, string> = { warn: "warning", critical: "critical", exceeded: "critical" };

export default function AlertsPage() {
  const { data, error, loading, reload } = useGateway<Alert[]>("alerts?limit=100");

  return (
    <Section
      title="Budget alerts"
      description="Raised when a budget crosses its warning, critical or exceeded threshold (deduplicated hourly)."
      action={<button className="btn" onClick={reload}>Refresh</button>}
    >
      <StateNote loading={loading} error={error} />
      {data && (
        <SimpleTable
          rows={data}
          rowKey={(a) => a.id}
          empty="No alerts. Budgets raise one when they cross a threshold."
          columns={[
            { header: "Severity", width: 110, cell: (a) => <Badge tone={TONE[a.severity]}>{a.severity}</Badge> },
            { header: "Alert", cell: (a) => (<><div style={{ color: "var(--fg)" }}>{a.title}</div><div className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>{a.message}</div></>) },
            { header: "Notified", width: 140, cell: (a) => (a.channels?.length ? a.channels.join(", ") : "dashboard only") },
            { header: "When", width: 190, cell: (a) => fmtTime(a.created_at) },
          ]}
        />
      )}
    </Section>
  );
}
