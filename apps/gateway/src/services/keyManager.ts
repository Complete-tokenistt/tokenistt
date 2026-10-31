import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export interface GeneratedKey {
  rawToken: string;      // Shown to user ONCE upon creation, never stored
  keyPrefix: string;     // Display prefix (e.g. "tktt_live_org1_abc...")
  keyHash: string;       // SHA-256 cryptographic hash stored in DB
}

/**
 * Computes deterministic SHA-256 hash of a bearer token.
 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Generates a cryptographically secure virtual key token (192 bits of entropy)
 * following the standard format: `tktt_live_{workspace}_{user}_{secret}`
 */
export function generateVirtualKey(
  workspaceOrOrg: string,
  userOrName: string
): GeneratedKey {
  const cleanWorkspace = workspaceOrOrg.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'ws';
  const cleanUser = userOrName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'key';
  const secret = randomBytes(24).toString('base64url'); // 192 bits entropy
  const rawToken = `tktt_live_${cleanWorkspace}_${cleanUser}_${secret}`;
  
  const keyPrefix = `${rawToken.slice(0, 20)}...`;
  const keyHash = hashToken(rawToken);

  return {
    rawToken,
    keyPrefix,
    keyHash,
  };
}

/**
 * Performs timing-safe comparison between input token hash and stored hash.
 */
export function verifyTokenHash(inputToken: string, storedHash: string): boolean {
  const computedHash = hashToken(inputToken);
  if (computedHash.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(computedHash), Buffer.from(storedHash));
}

