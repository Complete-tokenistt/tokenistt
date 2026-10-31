import type { ExpenseTransaction, ExpenseProvider } from "../types";

const BASE = "https://api.brex.com/v1";

// Normalize a Brex transaction. Brex returns `amount` in minor units (cents)
// and `user.email` for the spender — adjust the minor-unit divisor if your
// Brex app returns dollars.
export async function fetchBrexTransactions(
  token: string,
  sinceISO: string,
): Promise<ExpenseTransaction[]> {
  const out: ExpenseTransaction[] = [];
  let url: string | null = `${BASE}/transactions?limit=100&start_date=${sinceISO.slice(0, 10)}`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) break;
    const j = (await res.json()) as any;
    for (const t of j.transactions ?? []) {
      out.push({
        id: String(t.id),
        date: t.date ?? t.posted_at ?? new Date().toISOString(),
        description: t.description ?? t.merchant_name ?? "",
        // Brex amounts are in cents:
        amount: Math.abs(Number(t.amount ?? 0)) / 100,
        currency: t.currency ?? "USD",
        vendor: t.merchant_name ?? t.description ?? "",
        employeeEmail: t.user?.email ?? t.employee?.email,
        source: "brex" as ExpenseProvider,
        raw: t,
      });
    }
    url = j.page?.next_url ?? j.next ?? null;
  }
  return out;
}
