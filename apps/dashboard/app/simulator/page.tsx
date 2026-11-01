"use client";

import Link from "next/link";

export default function SimulatorPage() {
  return (
    <div className="card" style={{ padding: "48px 20px", textAlign: "center" }}>
      <div style={{ fontSize: 15, color: "var(--fg-2)", marginBottom: 8 }}>
        No baseline to simulate against yet
      </div>
      <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 520, margin: "0 auto 16px" }}>
        The simulator replays your own request history. Send traffic through the gateway first, and it will use your real spend and request volume as the baseline.
      </p>
      <Link href="/onboarding" className="btn btn-ghost btn-sm mono">
        Send your first request →
      </Link>
    </div>
  );
}
