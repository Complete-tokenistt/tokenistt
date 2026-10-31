/**
 * config/secrets.ts — Secret validation and configuration integrity checks.
 *
 * In production mode (NODE_ENV=production):
 *   - Strictly enforces presence of critical secrets (DATABASE_URL, ADMIN_SECRET, ENCRYPTION_KEY).
 *   - Disallows insecure fallback secrets.
 *   - Exits process with code 1 if critical security requirements are violated.
 *
 * In development / test mode:
 *   - Issues clear warnings but allows local mocking to function.
 */

export interface AppSecrets {
  databaseUrl?: string;
  redisUrl?: string;
  adminSecret: string;
  encryptionKey?: string;
  isProduction: boolean;
}

const INSECURE_DEFAULTS = [
  'dev-admin-secret-change-in-production',
  'default-secret',
  'fallback-admin-password',
  'secret',
  'admin',
  'password',
];

export function validateSecrets(): AppSecrets {
  const isProduction = process.env.NODE_ENV === 'production';
  const adminSecret = process.env.ADMIN_SECRET || 'dev-admin-secret-change-in-production';
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const encryptionKey = process.env.ENCRYPTION_KEY;
  const masterKey = process.env.MASTER_KEY;

  if (isProduction) {
    const missing: string[] = [];

    if (!databaseUrl) missing.push('DATABASE_URL');
    if (!process.env.ADMIN_SECRET) missing.push('ADMIN_SECRET');
    if (!encryptionKey) missing.push('ENCRYPTION_KEY');
    if (!masterKey) missing.push('MASTER_KEY');

    if (missing.length > 0) {
      console.error(`[FATAL SECURITY ERROR] Missing required environment variables in production: ${missing.join(', ')}`);
      process.exit(1);
    }

    if (INSECURE_DEFAULTS.includes(adminSecret.toLowerCase())) {
      console.error('[FATAL SECURITY ERROR] Insecure default ADMIN_SECRET detected in production environment.');
      process.exit(1);
    }

    if (encryptionKey && encryptionKey.length < 32) {
      console.error('[FATAL SECURITY ERROR] ENCRYPTION_KEY must be at least 32 characters in production.');
      process.exit(1);
    }

    // MASTER_KEY is used by vault.ts for AES-256-GCM encryption of BYOK provider API keys.
    // Without validation, the insecure default 'default-master-key-change-in-production' is used,
    // making all encrypted API keys trivially decryptable.
    const insecureMasterKeyDefaults = [
      'default-master-key-change-in-production',
      'dev-only-change-me-please-32+chars!!',
      'changeme',
      'secret',
    ];
    if (masterKey && insecureMasterKeyDefaults.includes(masterKey.toLowerCase())) {
      console.error('[FATAL SECURITY ERROR] MASTER_KEY is using a known insecure default. Set a unique, random MASTER_KEY in production.');
      process.exit(1);
    }
    if (masterKey && masterKey.length < 32) {
      console.error('[FATAL SECURITY ERROR] MASTER_KEY must be at least 32 characters in production.');
      process.exit(1);
    }
  } else {
    if (INSECURE_DEFAULTS.includes(adminSecret.toLowerCase())) {
      console.warn('[SECURITY WARNING] Using default development ADMIN_SECRET. Set ADMIN_SECRET in production.');
    }
    if (!masterKey || masterKey === 'default-master-key-change-in-production') {
      console.warn('[SECURITY WARNING] MASTER_KEY is unset or using insecure default. Set MASTER_KEY before deploying to production.');
    }
  }

  return {
    databaseUrl,
    redisUrl,
    adminSecret,
    encryptionKey,
    isProduction,
  };
}

