import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { encryptApiKey } from '../services/vault.js';
import { generateVirtualKey } from '../services/keyManager.js';
import { invalidateCachedVirtualKey } from '../services/redis.js';

export const providersRouter = Router();

// ---------------------------------------------------------------------------
// Admin authentication middleware — required for all provider management routes.
// Provider routes can store encrypted API keys into the database and make
// outbound HTTP calls to arbitrary URLs. Both operations require authentication.
// ---------------------------------------------------------------------------
function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const adminSecret = process.env.ADMIN_SECRET || 'dev-admin-secret-change-in-production';
  const headerSecret = req.headers['x-admin-secret'];

  if (!headerSecret || typeof headerSecret !== 'string') {
    res.status(401).json({
      error: {
        message: 'Unauthorized. Valid X-Admin-Secret header required.',
        type: 'authentication_error',
      },
    });
    return;
  }

  try {
    const expected = Buffer.from(adminSecret, 'utf-8');
    const provided = Buffer.from(headerSecret, 'utf-8');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      res.status(401).json({
        error: {
          message: 'Unauthorized. Valid X-Admin-Secret header required.',
          type: 'authentication_error',
        },
      });
      return;
    }
  } catch {
    res.status(401).json({
      error: { message: 'Unauthorized.', type: 'authentication_error' },
    });
    return;
  }
  next();
}

export function resolveBaseUrl(provider: string, customBaseUrl?: string, apiKey?: string): string {
  if (customBaseUrl && customBaseUrl.trim().length > 0) {
    return customBaseUrl.trim().replace(/\/+$/, '');
  }

  const p = provider.toLowerCase();
  if (p === 'groq' || (apiKey && apiKey.startsWith('gsk_'))) {
    return 'https://api.groq.com/openai/v1';
  }
  if (p === 'together') {
    return 'https://api.together.xyz/v1';
  }
  if (p === 'mistral') {
    return 'https://api.mistral.ai/v1';
  }
  if (p === 'anthropic') {
    return 'https://api.anthropic.com/v1';
  }
  return 'https://api.openai.com/v1';
}

/**
 * Validates a provider API key by executing a lightweight ping against upstream.
 * Only calls known provider base URLs unless a custom URL is explicitly provided
 * by an authenticated admin caller (SSRF protection: unauthenticated callers cannot
 * supply a custom base URL — this is enforced by the requireAdminAuth middleware
 * applied to /validate).
 */
export async function validateProviderKey(
  provider: string,
  apiKey: string,
  customBaseUrl?: string
): Promise<{ valid: boolean; latency_ms?: number; models?: string[]; error?: string; baseUrl: string }> {
  const baseUrl = resolveBaseUrl(provider, customBaseUrl, apiKey);
  const startTime = Date.now();

  try {
    if (provider.toLowerCase() === 'anthropic') {
      const resp = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10000),
      });

      const latencyMs = Date.now() - startTime;
      if (resp.ok) {
        const data = (await resp.json()) as any;
        const models = Array.isArray(data.data) ? data.data.map((m: any) => m.id).slice(0, 10) : [];
        return { valid: true, latency_ms: latencyMs, models, baseUrl };
      }

      const errJson = (await resp.json().catch(() => ({}))) as any;
      return {
        valid: false,
        error: errJson.error?.message || `Anthropic validation failed with status ${resp.status}`,
        baseUrl,
      };
    }

    // Default: OpenAI-compatible endpoints (OpenAI, Groq, Together, Mistral, etc.)
    const resp = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - startTime;
    if (resp.ok) {
      const data = (await resp.json()) as any;
      const models = Array.isArray(data.data) ? data.data.map((m: any) => m.id).slice(0, 10) : [];
      return { valid: true, latency_ms: latencyMs, models, baseUrl };
    }

    if (resp.status === 401 || resp.status === 403) {
      const errJson = (await resp.json().catch(() => ({}))) as any;
      return {
        valid: false,
        error: errJson.error?.message || 'Authentication failed: Invalid API key',
        baseUrl,
      };
    }

    // Some custom OpenAI endpoints don't support GET /models — try a minimal completion
    const testModel =
      provider.toLowerCase() === 'groq'
        ? 'llama-3.3-70b-versatile'
        : provider.toLowerCase() === 'mistral'
        ? 'mistral-small-latest'
        : 'gpt-4o-mini';

    const compResp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const compLatency = Date.now() - startTime;
    if (compResp.ok) {
      return { valid: true, latency_ms: compLatency, models: [testModel], baseUrl };
    }

    const compErr = (await compResp.json().catch(() => ({}))) as any;
    return {
      valid: false,
      error: compErr.error?.message || `Validation failed with status ${compResp.status}`,
      baseUrl,
    };
  } catch (err: any) {
    return {
      valid: false,
      error: err.name === 'TimeoutError' ? 'Connection timed out after 10s' : err.message,
      baseUrl,
    };
  }
}

/**
 * POST /v1/providers/validate — Requires X-Admin-Secret.
 * Validates a provider API key against the upstream provider.
 * Authentication is required to prevent SSRF (custom base URLs) and key-probing.
 */
providersRouter.post('/validate', requireAdminAuth, async (req: Request, res: Response) => {
  const { provider, apiKey, baseUrl } = req.body || {};

  if (!provider || !apiKey) {
    res.status(400).json({
      valid: false,
      error: 'Fields `provider` and `apiKey` are required',
    });
    return;
  }

  const result = await validateProviderKey(provider, apiKey, baseUrl);
  if (!result.valid) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

/**
 * POST /v1/providers/connect — Requires X-Admin-Secret.
 * Stores an encrypted provider API key in the database and creates a virtual key.
 * Authentication is CRITICAL: this route writes encrypted API keys and updates
 * ALL active virtual keys for the org with the new provider credential.
 */
providersRouter.post('/connect', requireAdminAuth, async (req: Request, res: Response) => {
  const { provider, apiKey, baseUrl, orgId: reqOrgId } = req.body || {};

  if (!provider || !apiKey) {
    res.status(400).json({
      success: false,
      error: 'Fields `provider` and `apiKey` are required',
    });
    return;
  }

  // Validate key against upstream provider
  const validation = await validateProviderKey(provider, apiKey, baseUrl);
  if (!validation.valid) {
    res.status(400).json({
      success: false,
      error: validation.error || 'Provider key validation failed',
    });
    return;
  }

  let orgId = reqOrgId || (req.headers['x-organization-id'] as string);

  if (process.env.DATABASE_URL) {
    try {
      const pool = getPool();
      if (!orgId) {
        if (process.env.NODE_ENV === 'production') {
          res.status(400).json({ success: false, error: 'Organization ID is required (via body.orgId or header x-organization-id)' });
          return;
        }
        const orgRes = await pool.query('SELECT id::text FROM organizations ORDER BY id ASC LIMIT 1');
        orgId = orgRes.rows[0]?.id || '1';
      }

      const encryptedKey = encryptApiKey(apiKey, orgId);
      const credPayload = {
        provider,
        base_url: validation.baseUrl,
        encrypted_key: encryptedKey,
        connected_at: new Date().toISOString(),
      };

      await pool.query(
        `UPDATE organizations
         SET settings = jsonb_set(
           COALESCE(settings, '{}'::jsonb),
           ARRAY['provider_credentials', $1::text],
           $2::jsonb,
           true
         )
         WHERE id = $3`,
        [provider.toLowerCase(), JSON.stringify(credPayload), orgId]
      );

      const keyInfo = generateVirtualKey(`org${orgId}`, provider.toLowerCase());
      const metadata = {
        real_api_key: encryptedKey,
        provider: provider.toLowerCase(),
        base_url: validation.baseUrl,
        enforcement_mode: 'hard_cap',
        rate_limit_per_minute: 100,
      };

      const vkInsert = await pool.query(
        `INSERT INTO virtual_keys (organization_id, name, key_prefix, key_hash, status, metadata)
         VALUES ($1, $2, $3, $4, 'active', $5)
         RETURNING id::text, public_id::text, key_prefix, created_at`,
        [orgId, `Onboarding (${provider})`, keyInfo.keyPrefix, keyInfo.keyHash, JSON.stringify(metadata)]
      );

      // Update existing active dev keys with the new provider credential
      await pool.query(
        `UPDATE virtual_keys
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{real_api_key}', $1::jsonb)
         WHERE organization_id = $2 AND status = 'active'`,
        [JSON.stringify(encryptedKey), orgId]
      );

      await invalidateCachedVirtualKey(keyInfo.rawToken).catch(() => {});

      res.json({
        success: true,
        provider: provider.toLowerCase(),
        org_id: orgId,
        raw_token: keyInfo.rawToken,
        key_prefix: keyInfo.keyPrefix,
        virtual_key_id: vkInsert.rows[0]?.id,
        latency_ms: validation.latency_ms,
        base_url: validation.baseUrl,
      });
      return;
    } catch (err: any) {
      console.error('[POST /v1/providers/connect] DB error:', err.message);
      res.status(500).json({ success: false, error: err.message });
      return;
    }
  }

  // Dev mode: DATABASE_URL not set
  res.json({
    success: true,
    provider: provider.toLowerCase(),
    org_id: '1',
    raw_token: `tktt_live_dev_${provider.toLowerCase()}_mocktoken123`,
    key_prefix: `tktt_live_dev_${provider.toLowerCase()}...`,
    latency_ms: validation.latency_ms,
    base_url: validation.baseUrl,
  });
});

/**
 * GET /v1/providers/list — Requires X-Admin-Secret.
 * Returns connected providers for the organization.
 * Authentication required to prevent metadata enumeration.
 */
providersRouter.get('/list', requireAdminAuth, async (req: Request, res: Response) => {
  let orgId = (req.query.orgId as string) || (req.headers['x-organization-id'] as string);

  if (!process.env.DATABASE_URL) {
    res.json({
      providers: [
        { provider: 'groq', connected: true, base_url: 'https://api.groq.com/openai/v1', connected_at: new Date().toISOString() },
      ],
    });
    return;
  }

  try {
    const pool = getPool();
    if (!orgId) {
      if (process.env.NODE_ENV === 'production') {
        res.status(400).json({ error: 'Organization ID is required (via query.orgId or header x-organization-id)' });
        return;
      }
      const orgRes = await pool.query('SELECT id::text FROM organizations ORDER BY id ASC LIMIT 1');
      orgId = orgRes.rows[0]?.id || '1';
    }

    const { rows } = await pool.query<{ settings: any }>(
      'SELECT settings FROM organizations WHERE id = $1',
      [orgId]
    );

    const creds = rows[0]?.settings?.provider_credentials || {};
    const providersList = Object.entries(creds).map(([prov, data]: [string, any]) => ({
      provider: prov,
      connected: true,
      base_url: data.base_url,
      connected_at: data.connected_at,
    }));

    res.json({ org_id: orgId, providers: providersList });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
