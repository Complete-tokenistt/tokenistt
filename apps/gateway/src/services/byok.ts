/**
 * services/byok.ts — BYOK provider-key resolver with key-level failover.
 *
 * Keys come from `provider_keys` (encrypted with vault.ts), tried by ascending
 * priority; workspace-scoped keys win over org-wide ones. The legacy single key
 * stored on the virtual key (`auth.realApiKey`) and finally the gateway's own
 * environment key (null) are the last resorts, so existing setups keep working.
 */
import { getPool } from '../db/pool.js';
import type { AuthContext } from '../db/auth.js';
import { decryptApiKey, encryptApiKey } from './vault.js';

export interface KeyCandidate {
  /** provider_keys.public_id, or null for the legacy/default key */
  id: string | null;
  key: string | null;
  label: string;
}

export async function resolveKeys(auth: AuthContext, provider: string): Promise<KeyCandidate[]> {
  const out: KeyCandidate[] = [];

  if (process.env.DATABASE_URL && auth.organizationId !== BigInt(0)) {
    try {
      const { rows } = await getPool().query<{ public_id: string; label: string; encrypted_key: string }>(
        `SELECT public_id::text, label, encrypted_key
           FROM provider_keys
          WHERE organization_id = $1 AND provider = $2 AND status <> 'disabled'
            AND (workspace_id IS NULL OR workspace_id = $3)
          ORDER BY (workspace_id IS NULL), (status = 'failing'), priority ASC, id ASC`,
        [auth.organizationId.toString(), provider, auth.workspaceId?.toString() ?? null]
      );
      for (const r of rows) {
        try {
          out.push({ id: r.public_id, label: r.label, key: decryptApiKey(r.encrypted_key, auth.organizationId.toString()) });
        } catch {
          console.warn(`[BYOK] could not decrypt provider key ${r.public_id}; skipping`);
        }
      }
    } catch (err: any) {
      console.warn('[BYOK] provider_keys lookup failed, falling back:', err.message);
    }
  }

  if (auth.realApiKey) out.push({ id: null, key: auth.realApiKey, label: 'virtual-key' });
  out.push({ id: null, key: null, label: 'gateway-default' });
  return out;
}

/** Errors that mean "this key is bad/limited — try the next key" (not a request problem). */
export function isKeyFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /authentication failed|rate limit|\((?:401|403|429|5\d\d)\)|invalid api key|quota/i.test(msg);
}

export async function markKeyResult(keyId: string | null, ok: boolean, error?: string): Promise<void> {
  if (!keyId || !process.env.DATABASE_URL) return;
  try {
    await getPool().query(
      ok
        ? `UPDATE provider_keys SET status = 'active', last_error = NULL, last_used_at = now() WHERE public_id = $1`
        : `UPDATE provider_keys SET status = 'failing', last_error = $2, last_used_at = now() WHERE public_id = $1`,
      ok ? [keyId] : [keyId, (error ?? '').slice(0, 500)]
    );
  } catch { /* best effort */ }
}

export async function addProviderKey(args: {
  organizationId: string;
  workspaceId?: string | null;
  provider: string;
  label?: string;
  apiKey: string;
  priority?: number;
}): Promise<{ id: string }> {
  const { rows } = await getPool().query<{ public_id: string }>(
    `INSERT INTO provider_keys (organization_id, workspace_id, provider, label, encrypted_key, priority)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING public_id::text`,
    [args.organizationId, args.workspaceId ?? null, args.provider, args.label ?? 'default',
     encryptApiKey(args.apiKey, args.organizationId), args.priority ?? 100]
  );
  return { id: rows[0].public_id };
}
