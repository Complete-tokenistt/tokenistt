import { GATEWAY_URL } from "./config";

export interface SpendReport {
  user: string;
  date: string;
  spendUsd: number;
  calls: number;
  source: "gateway" | "mock";
}

// Current user's daily spend. Uses the gateway's usage endpoint when
// configured; otherwise returns a deterministic mock so the resource works
// standalone.
export async function getDailySpend(user: string): Promise<SpendReport> {
  const today = new Date().toISOString().slice(0, 10);

  if (GATEWAY_URL) {
    try {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const u = new URL(`${GATEWAY_URL.replace(/\/$/, "")}/internal/usage`);
      u.searchParams.set("actor", user);
      u.searchParams.set("from", from.toISOString());
      u.searchParams.set("to", new Date().toISOString());
      const res = await fetch(u.toString());
      if (res.ok) {
        const j = (await res.json()) as { spendUsd?: number; calls?: number };
        return {
          user,
          date: today,
          spendUsd: j.spendUsd ?? 0,
          calls: j.calls ?? 0,
          source: "gateway",
        };
      }
    } catch {
      /* fall through to mock */
    }
  }

  let h = 0;
  for (const c of user) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return {
    user,
    date: today,
    spendUsd: Number((((h % 5000) / 100) + 5).toFixed(2)),
    calls: (h % 200) + 10,
    source: "mock",
  };
}
