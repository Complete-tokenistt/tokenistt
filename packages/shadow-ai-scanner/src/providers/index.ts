import type { ExpenseProvider, ExpenseTransaction } from "../types";
import { fetchBrexTransactions } from "./brex";
import { fetchRampTransactions } from "./ramp";

export async function fetchTransactions(
  provider: ExpenseProvider,
  token: string,
  sinceISO: string,
): Promise<ExpenseTransaction[]> {
  if (provider === "brex") return fetchBrexTransactions(token, sinceISO);
  if (provider === "ramp") return fetchRampTransactions(token, sinceISO);
  return [];
}
