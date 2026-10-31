"use client";

import { useState } from "react";
import Section from "@/components/Section";
import Badge from "@/components/Badge";
import { SimpleTable, fmtTime } from "@/components/SimpleTable";
import { StateNote, gatewayFetch, useGateway } from "@/lib/useGateway";

type Approval = {
  public_id: string; requester: string | null; model: string | null; reason: string | null;
  status: "pending" | "approved" | "denied" | "expired"; decided_by: string | null; expires_at: string; created_at: string;
};

const TONE: Record<string, string> = { pending: "warning", approved: "ok", denied: "critical", expired: "missing" };

export default function ApprovalsPage() {
  const { data, error, loading, reload } = useGateway<Approval[]>("approvals");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function decide(id: string, verb: "approve" | "deny") {
    if (verb === "deny" && !confirm("Deny this request? The caller will keep getting a 403.")) return;
    setBusy(id);
    setActionError(null);
    try {
      await gatewayFetch(`approvals/${id}/${verb}`, { method: "POST" });
      await reload();
    } catch (e: any) {
      setActionError(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title="Approval requests"
      description="Requests held by a require_approval policy. Once approved, the caller retries the identical request and it goes through."
      action={<button className="btn" onClick={reload}>Refresh</button>}
    >
      <StateNote loading={loading} error={error} />
      {actionError && <div className="mono" style={{ color: "var(--red)", fontSize: 13, marginBottom: 10 }}>{actionError}</div>}
      {data && (
        <SimpleTable
          rows={data}
          rowKey={(a) => a.public_id}
          empty="Nothing waiting for approval."
          columns={[
            { header: "Requested", width: 180, cell: (a) => fmtTime(a.created_at) },
            { header: "Who / what", cell: (a) => (<><div>{a.requester ?? "—"} → {a.model ?? "—"}</div><div className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>{a.reason}</div></>) },
            { header: "Status", width: 150, cell: (a) => (<><Badge tone={TONE[a.status]}>{a.status}</Badge>{a.decided_by && <div className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>by {a.decided_by}</div>}</>) },
            {
              header: "", width: 190,
              cell: (a) => a.status === "pending" ? (
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <button className="btn" disabled={busy === a.public_id} onClick={() => decide(a.public_id, "approve")}>Approve</button>
                  <button className="btn" disabled={busy === a.public_id} onClick={() => decide(a.public_id, "deny")}>Deny</button>
                </span>
              ) : null,
            },
          ]}
        />
      )}
    </Section>
  );
}
