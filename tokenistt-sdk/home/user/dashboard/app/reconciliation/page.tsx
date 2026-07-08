import { getInvoices, reconcile } from "@/lib/mock-data";
import Section from "@/components/Section";
import ReconciliationView from "@/components/ReconciliationView";

export default function ReconciliationPage() {
  const initialRows = reconcile(getInvoices());

  return (
    <div className="space-y-6">
      <Section
        title="Invoice Reconciliation"
        description="Match ledger-calculated costs against uploaded vendor invoices (CSV / PDF)"
      >
        <ReconciliationView initialRows={initialRows} />
      </Section>
    </div>
  );
}
