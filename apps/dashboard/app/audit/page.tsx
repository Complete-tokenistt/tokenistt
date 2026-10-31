"use client";

import Section from "@/components/Section";
import Badge from "@/components/Badge";
import { SimpleTable, fmtTime } from "@/components/SimpleTable";
import { StateNote, useGateway } from "@/lib/useGateway";

type Action = { id: string; actor: string; action: string; entity_type: string | null; entity_id: string | null; created_at: string };
type Decision = { id: string; kind: string; decision: string; reason: string | null; request_id: string | null; created_at: string };
type Audit = { actions: Action[]; decisions: Decision[] };

const DECISION_TONE: Record<string, string> = { allow: "ok", approved: "ok", route: "ok", warn: "warning", throttle: "warning", require_approval: "warning", block: "critical", force_model: "medium" };

export default function AuditPage() {
  const { data, error, loading, reload } = useGateway<Audit>("audit?limit=100");

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <Section
        title="Admin actions"
        description="Every change to budgets, policies, routes, keys and connectors. Append-only: the database rejects edits and deletes."
        action={<button className="btn" onClick={reload}>Refresh</button>}
      >
        <StateNote loading={loading} error={error} />
        {data && (
          <SimpleTable
            rows={data.actions}
            rowKey={(a) => a.id}
            empty="No admin actions recorded yet."
            columns={[
              { header: "When", width: 190, cell: (a) => fmtTime(a.created_at) },
              { header: "Actor", cell: (a) => a.actor },
              { header: "Action", cell: (a) => <span className="mono">{a.action}</span> },
              { header: "Entity", cell: (a) => (a.entity_type ? `${a.entity_type} ${a.entity_id ?? ""}` : "—") },
            ]}
          />
        )}
      </Section>

      <Section title="Automated decisions" description="What the gateway decided about requests: policy, budget and routing outcomes.">
        {data && (
          <SimpleTable
            rows={data.decisions}
            rowKey={(d) => d.id}
            empty="No automated decisions yet."
            columns={[
              { header: "When", width: 190, cell: (d) => fmtTime(d.created_at) },
              { header: "Kind", width: 90, cell: (d) => d.kind },
              { header: "Decision", width: 150, cell: (d) => <Badge tone={DECISION_TONE[d.decision]}>{d.decision}</Badge> },
              { header: "Reason", cell: (d) => <span className="mono" style={{ fontSize: 12 }}>{d.reason ?? "—"}</span> },
              { header: "Request", cell: (d) => <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>{d.request_id ?? "—"}</span> },
            ]}
          />
        )}
      </Section>
    </div>
  );
}
