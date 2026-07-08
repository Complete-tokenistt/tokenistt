import type { ExpenseTransaction, ExpenseProvider } from "../types";

const BASE = "https://api.ramp.com/developer/v1";

// Normalize a Ramp transaction. Ramp returns `amount` in minor units (cents)
// and `user.email` for the spender.
export async function fetchRampTransactions(
  token: string,
  sinceISO: string,
): Promise<ExpenseTransaction[]> {
  const out: ExpenseTransaction[] = [];
  let url: string | null = `${BASE}/transactions?limit=100&from_date=${sinceISO.slice(0, 10)}`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) break;
    const j = (await res.json()) as any;
    for (const t of j.transactions ?? []) {
      out.push({
        id: String(t.id),
        date: t.posted_at ?? t.created_at ?? new Date().toISOString(),
        description: t.merchant ?? t.description ?? "",
        amount: Math.abs(Number(t.amount ?? 0)) / 100,
        currency: t.currency ?? "USD",
        vendor: t.merchant ?? "",
        employeeEmail: t.user?.email ?? t.user_email,
        source: "ramp" as ExpenseProvider,
        raw: t,
      });
    }
    url = j.page?.next_url ?? j.next ?? null;
  }
  return out;
}
