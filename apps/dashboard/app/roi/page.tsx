"use client";

import Link from "next/link";

export default function RoiDashboardPage() {
  return (
    <div className="card" style={{ padding: "48px 20px", textAlign: "center" }}>
      <div style={{ fontSize: 15, color: "var(--fg-2)", marginBottom: 8 }}>
        No ROI data yet
      </div>
      <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 520, margin: "0 auto 16px" }}>
        ROI needs both spend and a value source (for example a connected analytics or CRM connector). Neither is available for this workspace yet.
      </p>
      <Link href="/onboarding" className="btn btn-ghost btn-sm mono">
        Send your first request →
      </Link>
    </div>
  );
}
