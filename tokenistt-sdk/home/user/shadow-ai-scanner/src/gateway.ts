import type { AiVendor } from "./types";
import { GATEWAY_URL } from "./config";

export interface GatewayUsage {
  spendUsd: number;
  calls: number;
}

// Does this actor have *corporate* gateway usage for this vendor in the period?
// Real impl: GET <gateway>/internal/usage?actor=&vendor=&from=&to= (returns
// { spendUsd, calls }). If GATEWAY_URL is unset we assume no corporate usage,
// which is the correct default: an AI expense with no matched corporate API
// activity means the employee is on a personal account -> Shadow Spend.
export async function getGatewayUsage(
  _orgId: string,
  actor: string,
  vendor: AiVendor,
  fromISO: string,
  toISO: string,
): Promise<GatewayUsage> {
  if (!GATEWAY_URL) return { spendUsd: 0, calls: 0 };
  try {
    const u = new URL(`${GATEWAY_URL.replace(/\/$/, "")}/internal/usage`);
    u.searchParams.set("actor", actor);
    u.searchParams.set("vendor", vendor);
    u.searchParams.set("from", fromISO);
    u.searchParams.set("to", toISO);
    const res = await fetch(u.toString());
    if (!res.ok) return { spendUsd: 0, calls: 0 };
    const j = (await res.json()) as Partial<GatewayUsage>;
    return { spendUsd: j.spendUsd ?? 0, calls: j.calls ?? 0 };
  } catch {
    return { spendUsd: 0, calls: 0 };
  }
}
