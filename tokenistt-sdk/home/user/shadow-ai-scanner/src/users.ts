import type { OrgConfig } from "./types";

// Match an expense's employee email to your user database.
// Real impl: query the gateway/IdP user directory. Here we match the configured
// org user list and fall back to deriving the gateway actor from the email
// local-part (so downstream gateway-usage lookups still work).
export function findUserByEmail(
  org: OrgConfig,
  email?: string,
): { email: string; actor: string; name?: string } | null {
  if (!email) return null;
  const e = email.toLowerCase();
  const u = org.users?.find((x) => x.email.toLowerCase() === e);
  if (u) return u;
  const local = e.split("@")[0];
  return { email: e, actor: local };
}
