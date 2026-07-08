import type { ExpenseProvider } from "./types";
import { OAUTH } from "./config";
import { tokenStore } from "./tokenStore";

interface ProviderMeta {
  auth: string;
  token: string;
  scope: string;
  grant: string;
}

const META: Record<ExpenseProvider, ProviderMeta> = {
  brex: {
    auth: "https://api.brex.com/oauth/authorize",
    token: "https://api.brex.com/oauth/token",
    scope: "transactions:read",
    grant: "authorization_code",
  },
  ramp: {
    auth: "https://app.ramp.com/v1/authorize",
    token: "https://app.ramp.com/v1/token",
    scope: "transactions:read",
    grant: "authorization_code",
  },
  navan: { auth: "", token: "", scope: "", grant: "" },
};

// Step 1: redirect the user here to authorize the expense provider.
export function getAuthUrl(provider: ExpenseProvider, state: string): string {
  const c = OAUTH[provider];
  const m = META[provider];
  const u = new URL(m.auth);
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", c.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", m.scope);
  u.searchParams.set("state", `${provider}:${state}`);
  return u.toString();
}

// Step 2: exchange the authorization code for tokens (called from your callback).
export async function exchangeCode(
  provider: ExpenseProvider,
  code: string,
  orgId: string,
): Promise<void> {
  const c = OAUTH[provider];
  const m = META[provider];
  const res = await fetch(m.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: m.grant,
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`OAuth exchange failed (${provider}): ${res.status}`);
  const j = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  tokenStore.set(provider, orgId, {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
  });
}

// Returns a valid access token, refreshing if expired.
export async function getValidToken(
  provider: ExpenseProvider,
  orgId: string,
): Promise<string | null> {
  const t = tokenStore.get(provider, orgId);
  if (!t) return null;

  if (t.expiresAt && t.expiresAt < Date.now() - 60_000 && t.refreshToken) {
    try {
      const c = OAUTH[provider];
      const m = META[provider];
      const res = await fetch(m.token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: t.refreshToken,
          client_id: c.clientId,
          client_secret: c.clientSecret,
        }),
      });
      if (res.ok) {
        const j = (await res.json()) as { access_token: string; expires_in?: number };
        tokenStore.set(provider, orgId, {
          ...t,
          accessToken: j.access_token,
          expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : t.expiresAt,
        });
        return j.access_token;
      }
    } catch {
      /* fall through to existing token */
    }
  }
  return t.accessToken;
}
