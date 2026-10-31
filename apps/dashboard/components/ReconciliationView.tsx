"use client";

import { useState } from "react";
import type { ReconciliationRow } from "@/lib/types";
import InvoiceUploader from "./InvoiceUploader";
import ReconciliationTable from "./ReconciliationTable";

export default function ReconciliationView({
  initialRows,
}: {
  initialRows: ReconciliationRow[];
}) {
  const [rows, setRows] = useState<ReconciliationRow[]>(initialRows);

  return (
    <div className="space-y-6">
      <InvoiceUploader onReconciled={setRows} />
      <ReconciliationTable rows={rows} />
    </div>
  );
}
