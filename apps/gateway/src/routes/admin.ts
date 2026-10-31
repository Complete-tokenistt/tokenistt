import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { invalidateCachedVirtualKey } from '../services/redis.js';
import { generateVirtualKey } from '../services/keyManager.js';
import { encryptApiKey } from '../services/vault.js';

export const adminRouter = Router();

// Middleware: Authenticate Admin Request via X-Admin-Secret header
function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const adminSecret = process.env.ADMIN_SECRET || 'dev-admin-secret-change-in-production';
  const headerSecret = req.headers['x-admin-secret'];

  if (!headerSecret || typeof headerSecret !== 'string') {
    res.status(401).json({
      error: {
        message: 'Unauthorized admin request. Valid X-Admin-Secret header required.',
        type: 'authentication_error',
      },
    });
    return;
  }

  // Use timing-safe comparison to prevent timing attacks on the admin secret
  try {
    const expected = Buffer.from(adminSecret, 'utf-8');
    const provided = Buffer.from(headerSecret, 'utf-8');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      res.status(401).json({
        error: {
          message: 'Unauthorized admin request. Valid X-Admin-Secret header required.',
          type: 'authentication_error',
        },
      });
      return;
    }
  } catch {
    res.status(401).json({
      error: {
        message: 'Unauthorized admin request.',
        type: 'authentication_error',
      },
    });
    return;
  }
  next();
}

adminRouter.use(requireAdminAuth);

/**
 * GET /v1/admin/virtual-keys — List virtual keys (supports ?organization_id= filter)
 */
adminRouter.get('/virtual-keys', async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: { message: 'Database not configured' } });
    return;
  }

  try {
    const pool = getPool();
    const orgId = req.query.organization_id?.toString() || req.headers['x-organization-id']?.toString();

    let query = `
      SELECT 
        vk.id::text,
        vk.public_id::text,
        vk.organization_id::text,
        vk.workspace_id::text,
        COALESCE(ws.name, 'Default') AS workspace_name,
        COALESCE(ws.cost_center, 'default') AS cost_center,
        vk.name,
        vk.key_prefix,
        vk.budget_cap_usd::text,
        vk.budget_period,
        vk.allowed_providers,
        vk.status,
        vk.last_used_at,
        vk.created_at
      FROM virtual_keys vk
      LEFT JOIN workspaces ws ON ws.id = vk.workspace_id
    `;
    const params: any[] = [];
    if (orgId) {
      query += ` WHERE vk.organization_id = $1 `;
      params.push(orgId);
    }
    query += ` ORDER BY vk.created_at DESC `;

    const { rows } = await pool.query(query, params);

    res.json({ virtual_keys: rows });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * POST /v1/admin/virtual-keys — Create new virtual key
 */
adminRouter.post('/virtual-keys', async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: { message: 'Database not configured' } });
    return;
  }

  const {
    name,
    organization_id,
    workspace_id,
    budget_cap_usd,
    budget_period = 'monthly',
    allowed_providers = [],
    rate_limit_per_minute = 100,
    real_api_key = null,
  } = req.body;

  if (!name || !organization_id) {
    res.status(400).json({ error: { message: 'Fields name and organization_id are required' } });
    return;
  }

  try {
    const pool = getPool();
    const keyInfo = generateVirtualKey(`org_${organization_id}`, name);

    const metadata: Record<string, any> = {
      rate_limit_per_minute: parseInt(String(rate_limit_per_minute), 10) || 100,
      enforcement_mode: 'hard_cap',
    };
    if (real_api_key) {
      // Encrypted at rest (AES-256-GCM, per-org key); auth.ts decrypts on lookup.
      metadata.real_api_key = encryptApiKey(String(real_api_key), String(organization_id));
    }

    const { rows } = await pool.query(
      `
      INSERT INTO virtual_keys (
        organization_id,
        workspace_id,
        name,
        key_prefix,
        key_hash,
        budget_cap_usd,
        budget_period,
        allowed_providers,
        status,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
      RETURNING id::text, public_id::text, name, key_prefix, budget_cap_usd::text, status, created_at
      `,
      [
        organization_id,
        workspace_id || null,
        name,
        keyInfo.keyPrefix,
        keyInfo.keyHash,
        budget_cap_usd ? String(budget_cap_usd) : null,
        budget_period,
        allowed_providers,
        JSON.stringify(metadata),
      ]
    );

    res.json({
      success: true,
      raw_token: keyInfo.rawToken,
      virtual_key: rows[0],
    });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * PATCH /v1/admin/virtual-keys/:public_id — Update key status or budget
 */
adminRouter.patch('/virtual-keys/:public_id', async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: { message: 'Database not configured' } });
    return;
  }

  const { public_id } = req.params;
  const { status, budget_cap_usd } = req.body;

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `
      UPDATE virtual_keys
      SET 
        status = COALESCE($2, status),
        budget_cap_usd = COALESCE($3, budget_cap_usd)
      WHERE public_id = $1
      RETURNING id::text, public_id::text, key_prefix, status, budget_cap_usd::text
      `,
      [public_id, status || null, budget_cap_usd ? String(budget_cap_usd) : null]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: { message: 'Virtual key not found' } });
      return;
    }

    // Invalidate Redis cache if prefix is known
    if (rows[0].key_prefix) {
      await invalidateCachedVirtualKey(rows[0].key_prefix);
    }

    res.json({ success: true, virtual_key: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * DELETE /v1/admin/virtual-keys/:public_id — Revoke virtual key
 */
adminRouter.delete('/virtual-keys/:public_id', async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: { message: 'Database not configured' } });
    return;
  }

  const { public_id } = req.params;

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `
      UPDATE virtual_keys
      SET status = 'revoked', revoked_at = now()
      WHERE public_id = $1
      RETURNING id::text, public_id::text, key_prefix, status
      `,
      [public_id]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: { message: 'Virtual key not found' } });
      return;
    }

    if (rows[0].key_prefix) {
      await invalidateCachedVirtualKey(rows[0].key_prefix);
    }

    res.json({ success: true, message: 'Virtual key revoked', virtual_key: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * GET /v1/admin/pricing — List all active model pricing tiers
 */
adminRouter.get('/pricing', async (_req: Request, res: Response) => {
  try {
    const { getDetailedCatalog } = await import('../services/pricingDb.js');
    const catalog = await getDetailedCatalog();
    res.json({ success: true, count: catalog.length, catalog });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * POST /v1/admin/pricing — Upsert model pricing tier with effective dating
 */
adminRouter.post('/pricing', async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: { message: 'Database not configured' } });
    return;
  }

  const {
    provider,
    modelId,
    displayName,
    inputPricePer1m,
    outputPricePer1m,
    cachedInputPricePer1m,
    cacheWritePricePer1m,
    reasoningPricePer1m,
  } = req.body || {};

  if (!provider || !modelId || inputPricePer1m === undefined || outputPricePer1m === undefined) {
    res.status(400).json({
      error: { message: 'Fields provider, modelId, inputPricePer1m, and outputPricePer1m are required' },
    });
    return;
  }

  try {
    const pool = getPool();
    // 1. Terminate any existing active pricing for this provider + model
    await pool.query(
      `
      UPDATE model_catalog
      SET effective_to = CURRENT_DATE
      WHERE provider = $1 AND model_id = $2 AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
      `,
      [provider.toLowerCase(), modelId.toLowerCase()]
    );

    // 2. Insert new pricing record effective today
    const { rows } = await pool.query(
      `
      INSERT INTO model_catalog (
        provider,
        model_id,
        display_name,
        input_price_per_1m,
        output_price_per_1m,
        cached_input_price_per_1m,
        cache_write_price_per_1m,
        reasoning_price_per_1m,
        status,
        effective_from
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'active', CURRENT_DATE
      )
      RETURNING id::text, provider, model_id, input_price_per_1m, output_price_per_1m, effective_from
      `,
      [
        provider.toLowerCase(),
        modelId.toLowerCase(),
        displayName || modelId,
        inputPricePer1m,
        outputPricePer1m,
        cachedInputPricePer1m ?? null,
        cacheWritePricePer1m ?? null,
        reasoningPricePer1m ?? null,
      ]
    );

    // 3. Invalidate pricing cache
    const { invalidatePricingCache } = await import('../services/pricingDb.js');
    invalidatePricingCache();

    res.json({ success: true, message: 'Model pricing updated successfully', pricing: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

