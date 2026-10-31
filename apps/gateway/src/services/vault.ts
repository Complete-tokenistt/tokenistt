import crypto from 'crypto';

interface LocalBlob {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Resolves the MASTER_KEY used for AES-256-GCM BYOK API key encryption.
 *
 * In production (NODE_ENV=production or GATEWAY_REQUIRE_AUTH=true):
 *   - Throws if MASTER_KEY is not set. secrets.ts already blocks startup in this case,
 *     so this is a second line of defence for tests/imports that bypass validateSecrets().
 *
 * In development/test:
 *   - Emits a warning and uses the fallback. Keys encrypted with the fallback are
 *     NOT secure; they must be re-encrypted before production use.
 */
function resolveMasterKey(): string {
  const key = process.env.MASTER_KEY;
  const isProduction = process.env.NODE_ENV === 'production' || process.env.GATEWAY_REQUIRE_AUTH === 'true';

  if (!key) {
    if (isProduction) {
      // Hard fail in production — the fallback key is publicly known.
      throw new Error('[FATAL] MASTER_KEY is not set. Cannot encrypt/decrypt provider API keys. Set MASTER_KEY in your environment.');
    }
    // Development: warn and use a non-secret placeholder so tests run without crashing.
    // The placeholder is well-known; data encrypted with it has zero confidentiality.
    console.warn('[Security Warning] MASTER_KEY not set — using insecure development placeholder. Set MASTER_KEY before deploying to production.');
    return 'dev-only-insecure-master-key-placeholder!';
  }

  return key;
}

function keyForOrg(orgId: string, masterKey: string): Buffer {
  return crypto.hkdfSync('sha256', Buffer.from(masterKey), Buffer.from(orgId), Buffer.alloc(0), 32) as unknown as Buffer;
}

export function decryptApiKey(encryptedBlob: string, orgId: string): string {
  const masterKey = resolveMasterKey();
  try {
    const o = JSON.parse(encryptedBlob) as LocalBlob;
    if (o.v !== 1 || !o.iv || !o.tag || !o.data) {
      // Not a valid encryption blob — treat as plaintext (dev/legacy compatibility)
      return encryptedBlob;
    }
    const iv = Buffer.from(o.iv, 'base64');
    const tag = Buffer.from(o.tag, 'base64');
    const data = Buffer.from(o.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyForOrg(orgId, masterKey), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // Decryption failure (wrong key, corrupted blob) — return original string so caller
    // can handle gracefully rather than crashing the entire request.
    return encryptedBlob;
  }
}

export function encryptApiKey(plaintext: string, orgId: string): string {
  const masterKey = resolveMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyForOrg(orgId, masterKey), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob: LocalBlob = {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };
  return JSON.stringify(blob);
}
