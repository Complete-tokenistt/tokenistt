/**
 * services/pricingDb.ts — Database-backed Pricing Catalog with In-Memory Cache.
 *
 * Source of truth: PostgreSQL `model_catalog` table (seeded via 0002_model_catalog.sql).
 * Falls back to static definitions in `pricing.ts` if DB is unavailable.
 */

import { getPool } from '../db/pool.js';
import { PricingTier } from '../types/index.js';
import { PRICING as FALLBACK_PRICING } from './pricing.js';

export interface DbModelPricing {
  id?: string;
  provider: string;
  modelId: string;
  displayName: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cachedInputPricePer1m: number | null;
  cacheWritePricePer1m: number | null;
  reasoningPricePer1m: number | null;
  status: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

let pricingCache: Map<string, PricingTier> = new Map();
let detailedCatalogCache: DbModelPricing[] = [];
let lastLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Loads all active pricing records from `model_catalog` in PostgreSQL.
 */
export async function loadPricingFromDb(): Promise<Map<string, PricingTier>> {
  const now = Date.now();
  if (pricingCache.size > 0 && (now - lastLoadedAt) < CACHE_TTL_MS) {
    return pricingCache;
  }

  if (!process.env.DATABASE_URL) {
    // Dev or offline fallback
    pricingCache = new Map(Object.entries(FALLBACK_PRICING));
    lastLoadedAt = now;
    return pricingCache;
  }

  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      id: string;
      provider: string;
      model_id: string;
      display_name: string;
      input_price_per_1m: string;
      output_price_per_1m: string;
      cached_input_price_per_1m: string | null;
      cache_write_price_per_1m: string | null;
      reasoning_price_per_1m: string | null;
      status: string;
      effective_from: string;
      effective_to: string | null;
    }>(`
      SELECT 
        id::text,
        provider,
        model_id,
        display_name,
        input_price_per_1m::text,
        output_price_per_1m::text,
        cached_input_price_per_1m::text,
        COALESCE(cache_write_price_per_1m::text, NULL) AS cache_write_price_per_1m,
        reasoning_price_per_1m::text,
        status,
        effective_from::text,
        effective_to::text
      FROM model_catalog
      WHERE status = 'active'
        AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
      ORDER BY effective_from DESC
    `);

    const newMap = new Map<string, PricingTier>();
    const newCatalog: DbModelPricing[] = [];

    for (const r of rows) {
      const tier: PricingTier = {
        input: parseFloat(r.input_price_per_1m),
        output: parseFloat(r.output_price_per_1m),
        cachedInput: r.cached_input_price_per_1m ? parseFloat(r.cached_input_price_per_1m) : undefined,
        cacheWrite: r.cache_write_price_per_1m ? parseFloat(r.cache_write_price_per_1m) : undefined,
        reasoning: r.reasoning_price_per_1m ? parseFloat(r.reasoning_price_per_1m) : undefined,
      };

      const key = `${r.provider.toLowerCase()}:${r.model_id.toLowerCase()}`;
      newMap.set(key, tier);

      newCatalog.push({
        id: r.id,
        provider: r.provider,
        modelId: r.model_id,
        displayName: r.display_name,
        inputPricePer1m: tier.input,
        outputPricePer1m: tier.output,
        cachedInputPricePer1m: tier.cachedInput ?? null,
        cacheWritePricePer1m: tier.cacheWrite ?? null,
        reasoningPricePer1m: tier.reasoning ?? null,
        status: r.status,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
      });
    }

    // Merge in any static fallbacks that aren't yet in DB
    for (const [k, tier] of Object.entries(FALLBACK_PRICING)) {
      if (!newMap.has(k)) {
        newMap.set(k, tier);
      }
    }

    pricingCache = newMap;
    detailedCatalogCache = newCatalog;
    lastLoadedAt = now;
    return pricingCache;
  } catch (err: any) {
    console.warn('[PricingDB] Failed to load model_catalog from DB, using fallback:', err.message);
    pricingCache = new Map(Object.entries(FALLBACK_PRICING));
    lastLoadedAt = now;
    return pricingCache;
  }
}

/**
 * Resolves pricing tier dynamically, trying exact match, then prefix/family match.
 */
export async function resolvePricingTierDynamic(
  provider: string,
  model: string
): Promise<PricingTier | null> {
  const map = await loadPricingFromDb();
  const normProvider = provider.toLowerCase();
  let normModel = model.toLowerCase();

  if (normModel.startsWith(`${normProvider}:`)) {
    normModel = normModel.slice(normProvider.length + 1);
  }

  // 1. Exact match
  const directKey = `${normProvider}:${normModel}`;
  if (map.has(directKey)) {
    return map.get(directKey)!;
  }

  // 2. Prefix / Versioned model matching
  for (const [candidateKey, tier] of map.entries()) {
    if (candidateKey.startsWith(`${normProvider}:`)) {
      const candidateModel = candidateKey.slice(normProvider.length + 1);
      if (normModel.startsWith(candidateModel) || candidateModel.startsWith(normModel)) {
        return tier;
      }
    }
  }

  return null;
}

/**
 * Returns the active pricing catalog list for API/Admin views.
 */
export async function getDetailedCatalog(): Promise<DbModelPricing[]> {
  await loadPricingFromDb();
  return detailedCatalogCache;
}

/**
 * Force-invalidates cache to load newly inserted/updated pricing immediately.
 */
export function invalidatePricingCache(): void {
  lastLoadedAt = 0;
}

