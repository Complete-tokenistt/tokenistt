import type { OrgConfig, ScanResult, ShadowFinding } from "./types";
import { fetchTransactions } from "./providers";
import { scanExpense, vendorLabel } from "./scanner";
import { findUserByEmail } from "./users";
import { getGatewayUsage } from "./gateway";
import { getValidToken } from "./oauth";

// End-to-end scan for one org:
//   fetch expenses -> scan for AI vendors -> match employee -> check gateway
//   usage -> flag shadow + compute True Cost (API spend + expensed subscription)
export async function scanOrg(
  org: OrgConfig,
  periodStart: string,
  periodEnd: string,
): Promise<ScanResult> {
  const findings: ShadowFinding[] = [];

  for (const provider of org.providers) {
    const token = await getValidToken(provider, org.orgId);
    if (!token) {
      console.warn(`  [${org.orgId}] ${provider}: not connected (no token) — skipping`);
      continue;
    }

    const txs = await fetchTransactions(provider, token, periodStart);
    for (const tx of txs) {
      const scanned = scanExpense(tx);
      if (!scanned) continue;

      const email = scanned.employeeEmail;
      const user = findUserByEmail(org, email);
      const actor = user?.actor ?? email?.split("@")[0] ?? "unknown";

      const usage = user
        ? await getGatewayUsage(org.orgId, actor, scanned.vendor, periodStart, periodEnd)
        : { spendUsd: 0, calls: 0 };

      const hasUsage = usage.spendUsd > 0;
      const shadow = !hasUsage;
      const amount = tx.amount;

      findings.push({
        id: `sf-${provider}-${tx.id}`,
        detectedAt: new Date().toISOString(),
        source: "card-transaction",
        vendor: vendorLabel(scanned.vendor),
        employeeEmail: email,
        amountUsd: amount,
        hasGatewayUsage: hasUsage,
        shadow,
        apiSpendUsd: usage.spendUsd,
        trueCostUsd: usage.spendUsd + amount,
        note: shadow
          ? `No corporate gateway usage for ${actor} on ${vendorLabel(scanned.vendor)} — likely a personal account.`
          : `Corporate usage found for ${actor} on ${vendorLabel(scanned.vendor)}.`,
      });
    }
  }

  const shadowSpend = findings.filter((f) => f.shadow).reduce((s, f) => s + f.amountUsd, 0);
  const expensed = findings.reduce((s, f) => s + f.amountUsd, 0);
  const apiSpend = findings.reduce((s, f) => s + f.apiSpendUsd, 0);
  const trueCost = findings.reduce((s, f) => s + f.trueCostUsd, 0);

  return {
    orgId: org.orgId,
    runAt: new Date().toISOString(),
    periodStart,
    periodEnd,
    findings,
    totals: {
      shadowSpendUsd: shadowSpend,
      expensedUsd: expensed,
      apiSpendUsd: apiSpend,
      trueCostUsd: trueCost,
      shadowCount: findings.filter((f) => f.shadow).length,
    },
  };
}
