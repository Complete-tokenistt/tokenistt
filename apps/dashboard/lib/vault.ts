import crypto from 'crypto';

interface LocalBlob {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

// Must match the gateway's development placeholder (apps/gateway/src/services/vault.ts),
// otherwise keys saved from the dashboard can't be decrypted by the gateway in dev.
const DEV_PLACEHOLDER_KEY = 'dev-only-insecure-master-key-placeholder!';

const INSECURE_MASTER_KEYS = [
  'default-master-key-change-in-production',
  'dev-only-change-me-please-32+chars!!',
  DEV_PLACEHOLDER_KEY,
  'changeme',
  'secret',
];

/**
 * Resolves the MASTER_KEY used for AES-256-GCM BYOK API key encryption.
 * Production refuses to encrypt with a missing, known or short key, because the
 * placeholder is public and anything encrypted with it has no confidentiality.
 */
function resolveMasterKey(): string {
  const key = process.env.MASTER_KEY;
  const isProduction = process.env.NODE_ENV === 'production' || process.env.STRICT_AUTH === 'true';

  if (isProduction) {
    if (!key) {
      throw new Error('MASTER_KEY is not set. Cannot encrypt provider API keys.');
    }
    if (INSECURE_MASTER_KEYS.includes(key.toLowerCase()) || key.length < 32) {
      throw new Error('MASTER_KEY is insecure. Set a unique, random MASTER_KEY of at least 32 characters.');
    }
    return key;
  }

  if (!key) {
    console.warn('[Security Warning] MASTER_KEY not set — using insecure development placeholder. Set MASTER_KEY before deploying to production.');
    return DEV_PLACEHOLDER_KEY;
  }
  return key;
}

function keyForOrg(orgId: string, masterKey: string): any {
  return crypto.hkdfSync("sha256", Buffer.from(masterKey) as any, Buffer.from(orgId) as any, Buffer.alloc(0) as any, 32);
}

export function encryptApiKey(plaintext: string, orgId: string): string {
  const masterKey = resolveMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyForOrg(orgId, masterKey) as any, iv as any);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8") as any, cipher.final() as any]);
  const tag = cipher.getAuthTag();
  const blob: LocalBlob = {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  };
  return JSON.stringify(blob);
}
