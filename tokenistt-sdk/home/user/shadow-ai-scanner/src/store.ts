import fs from "fs";
import path from "path";
import type { ShadowFinding, ScanResult } from "./types";

const DIR = path.resolve(process.cwd(), "data");

// Dashboard-compatible event (mirrors Prompt 7 ShadowAiEvent).
export interface DashboardEvent {
  id: string;
  detectedAt: string;
  actor: string;
  source: string;
  vendor: string;
  amountUsd: number;
  status: string; // "unreviewed" (shadow) | "approved" (corporate)
  note?: string;
}

export function toDashboardEvents(findings: ShadowFinding[]): DashboardEvent[] {
  return findings.map((f) => ({
    id: f.id,
    detectedAt: f.detectedAt,
    actor: f.employeeEmail ?? "unknown",
    source: f.source,
    vendor: f.vendor,
    amountUsd: f.amountUsd,
    status: f.shadow ? "unreviewed" : "approved",
    note: f.note,
  }));
}

// Persist the scan: full result, dashboard events, and JSONL history.
export function saveResult(result: ScanResult): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "shadow-ai-results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(DIR, "shadow-ai-findings.json"),
    JSON.stringify(toDashboardEvents(result.findings), null, 2),
  );
  fs.appendFileSync(path.join(DIR, "shadow-ai-history.jsonl"), JSON.stringify(result) + "\n");
  fs.appendFileSync(
    path.join(DIR, "shadow-ai-findings.jsonl"),
    result.findings.map((f) => JSON.stringify(toDashboardEvents([f])[0])).join("\n") + "\n",
  );
}
