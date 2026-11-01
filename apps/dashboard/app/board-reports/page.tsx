"use client";

import Link from "next/link";

export default function BoardReportsPage() {
  return (
    <div className="card" style={{ padding: "48px 20px", textAlign: "center" }}>
      <div style={{ fontSize: 15, color: "var(--fg-2)", marginBottom: 8 }}>
        No board reports yet
      </div>
      <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 520, margin: "0 auto 16px" }}>
        Report templates, schedules and recipients are not configured. Reports will use your real spend and budget data once you have gateway traffic.
      </p>
      <Link href="/onboarding" className="btn btn-ghost btn-sm mono">
        Send your first request →
      </Link>
    </div>
  );
}
