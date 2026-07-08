import { ORGS, PERIOD_DAYS } from "./config";
import { scanOrg } from "./matcher";
import { saveResult } from "./store";
import { reportToDashboard } from "./reporter";

// Runs the full scan across all configured orgs for the lookback window.
export async function runScan(): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - PERIOD_DAYS * 86_400_000);
  const fromISO = start.toISOString();
  const toISO = end.toISOString();

  if (ORGS.length === 0) {
    console.warn("No orgs configured (SCANNER_ORGS). Nothing to scan.");
    return;
  }

  for (const org of ORGS) {
    console.log(`Scanning org "${org.orgId}" (providers: ${org.providers.join(", ")})…`);
    const result = await scanOrg(org, fromISO, toISO);
    saveResult(result);
    console.log(
      `  findings=${result.findings.length} shadow=${result.totals.shadowCount} ` +
        `expensed=$${result.totals.expensedUsd.toFixed(2)} ` +
        `trueCost=$${result.totals.trueCostUsd.toFixed(2)}`,
    );
    await reportToDashboard(result.findings);
  }
}
