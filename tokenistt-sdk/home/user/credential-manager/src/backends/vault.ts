import type { CryptoBackend } from "../types";
import { VAULT_ADDR, VAULT_TOKEN } from "../config";

// HashiCorp Vault Transit backend. A PER-ORG transit key
// (`tokenistt-<orgId>`) is used so cryptographic isolation is enforced at the
// vault layer — org A's ciphertext cannot be decrypted under org B's key.
function headers(): Record<string, string> {
  return { "X-Vault-Token": VAULT_TOKEN, "Content-Type": "application/json" };
}

function transitKey(orgId: string): string {
  return `tokenistt-${orgId}`;
}

async function ensureKey(orgId: string): Promise<void> {
  const name = transitKey(orgId);
  // 204 = already exists; 400/409 are benign for "exists".
  await fetch(`${VAULT_ADDR}/v1/transit/keys/${name}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ type: "aes256-gcm96" }),
  }).catch(() => undefined);
}

export const vaultBackend: CryptoBackend = {
  name: "vault",

  async encrypt(orgId: string, plaintext: string): Promise<string> {
    await ensureKey(orgId);
    const name = transitKey(orgId);
    const res = await fetch(`${VAULT_ADDR}/v1/transit/encrypt/${name}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ plaintext: Buffer.from(plaintext).toString("base64") }),
    });
    if (!res.ok) throw new Error(`Vault encrypt failed: ${res.status}`);
    const j = (await res.json()) as { data: { ciphertext: string } };
    return j.data.ciphertext;
  },

  async decrypt(orgId: string, blob: string): Promise<string> {
    const name = transitKey(orgId);
    const res = await fetch(`${VAULT_ADDR}/v1/transit/decrypt/${name}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ciphertext: blob }),
    });
    if (!res.ok) throw new Error(`Vault decrypt failed: ${res.status}`);
    const j = (await res.json()) as { data: { plaintext: string } };
    return Buffer.from(j.data.plaintext, "base64").toString("utf8");
  },

  async rotateRoot(orgId: string): Promise<void> {
    const name = transitKey(orgId);
    const res = await fetch(`${VAULT_ADDR}/v1/transit/keys/${name}/rotate`, {
      method: "POST",
      headers: headers(),
    });
    if (!res.ok) throw new Error(`Vault rotate failed: ${res.status}`);
  },
};
