import dotenv from "dotenv";
dotenv.config();

import type { ExpenseProvider, OrgConfig } from "./types";

export const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
export const SCAN_CRON = process.env.SCAN_CRON || "0 6 * * *";
export const PERIOD_DAYS = Number(process.env.SHADOW_AI_PERIOD_DAYS || 30);
export const DASHBOARD_URL = process.env.DASHBOARD_URL || "";
export const GATEWAY_URL = process.env.GATEWAY_URL || "";

export const ORGS: OrgConfig[] = parseOrgs(process.env.SCANNER_ORGS);
function parseOrgs(raw?: string): OrgConfig[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as OrgConfig[];
  } catch {
    console.warn("SCANNER_ORGS is not valid JSON; no orgs configured.");
    return [];
  }
}

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const OAUTH: Record<ExpenseProvider, OAuthApp> = {
  brex: {
    clientId: process.env.BREX_CLIENT_ID || "",
    clientSecret: process.env.BREX_CLIENT_SECRET || "",
    redirectUri: process.env.BREX_REDIRECT_URI || "",
  },
  ramp: {
    clientId: process.env.RAMP_CLIENT_ID || "",
    clientSecret: process.env.RAMP_CLIENT_SECRET || "",
    redirectUri: process.env.RAMP_REDIRECT_URI || "",
  },
  navan: { clientId: "", clientSecret: "", redirectUri: "" },
};
