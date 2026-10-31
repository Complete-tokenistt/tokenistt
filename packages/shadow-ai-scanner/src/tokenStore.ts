import fs from "fs";
import path from "path";
import type { ExpenseProvider } from "./types";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
}

const FILE = path.resolve(process.cwd(), "data", "tokens.json");

function load(): Record<string, TokenSet> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, TokenSet>;
  } catch {
    return {};
  }
}

function save(all: Record<string, TokenSet>): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

const key = (p: ExpenseProvider, orgId: string) => `${p}:${orgId}`;

export const tokenStore = {
  get(p: ExpenseProvider, orgId: string): TokenSet | undefined {
    return load()[key(p, orgId)];
  },
  set(p: ExpenseProvider, orgId: string, t: TokenSet): void {
    const all = load();
    all[key(p, orgId)] = t;
    save(all);
  },
};
