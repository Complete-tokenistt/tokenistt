import type { ShadowFinding } from "./types";
import { toDashboardEvents } from "./store";
import { DASHBOARD_URL } from "./config";

// Push findings into the Prompt 7 Next.js dashboard (POST /api/shadow-ai/scan).
// No-op unless DASHBOARD_URL is configured.
export async function reportToDashboard(findings: ShadowFinding[]): Promise<void> {
  if (!DASHBOARD_URL || findings.length === 0) return;
  try {
    const res = await fetch(`${DASHBOARD_URL.replace(/\/$/, "")}/api/shadow-ai/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: toDashboardEvents(findings) }),
    });
    if (!res.ok) console.warn(`Dashboard report failed: ${res.status}`);
    else console.log(`Reported ${findings.length} findings to dashboard (${DASHBOARD_URL})`);
  } catch (e) {
    console.warn("Dashboard report error:", e);
  }
}
