import pg from 'pg';
import { RedisCache } from '../cache/redis.js';
import { 
  VirtualKeyToken, 
  VirtualKeyLookupResult,
  FinOpsConfig 
} from '../types/index.js';

const VIRTUAL_KEY_PREFIX = 'virtual_key:';
const DEFAULT_CACHE_TTL = 60; // 1 minute

export interface VirtualKeyStore {
  findByToken(token: string): Promise<VirtualKeyLookupResult | null>;
}

export class VirtualKeyService {
  private cache: RedisCache;
  private cacheTtl: number;
  private store: VirtualKeyStore;
  
  constructor(cache: RedisCache, store?: VirtualKeyStore) {
    this.cache = cache;
    this.cacheTtl = DEFAULT_CACHE_TTL;
    this.store = store || new InMemoryVirtualKeyStore();
  }
  
  setCacheTtl(seconds: number): void {
    this.cacheTtl = seconds;
  }
  
  async lookup(token: VirtualKeyToken): Promise<VirtualKeyLookupResult | null> {
    const cacheKey = `${VIRTUAL_KEY_PREFIX}${token.raw}`;
    
    // Try cache first
    const cached = await this.cache.get<VirtualKeyLookupResult>(cacheKey);
    if (cached) {
      return cached;
    }
    
    // Lookup in store
    const result = await this.store.findByToken(token.raw);
    
    if (result) {
      // Cache the result
      await this.cache.set(cacheKey, result, this.cacheTtl);
    }
    
    return result;
  }
  
  async invalidateCache(token: string): Promise<void> {
    const cacheKey = `${VIRTUAL_KEY_PREFIX}${token}`;
    await this.cache.delete(cacheKey);
  }
  
  async updateBudgetRemaining(
    token: string,
    newBudget: number
  ): Promise<void> {
    // Invalidate cache
    await this.invalidateCache(token);
    
    // Also update in store
    await this.store.findByToken(token);
  }
}

// Parse token format: tktt_live_{workspace}_{user}_{hash}
export function parseVirtualKeyToken(authHeader: string): VirtualKeyToken | null {
  if (!authHeader) {
    return null;
  }
  
  // Handle "Bearer tktt_live_..." format
  let token = authHeader;
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.substring(7);
  }
  
  const parts = token.split('_');
  
  if (parts.length < 5) {
    return null;
  }
  
  const prefix = parts[0];
  const prefixType = parts[1];
  
  if (prefix !== 'tktt' || (prefixType !== 'live' && prefixType !== 'test')) {
    return null;
  }
  
  const fullPrefix = `${prefix}_${prefixType}`;
  const hash = parts[parts.length - 1];
  const workspace = parts[2];
  const userId = parts.slice(3, -1).join('_');
  
  if (!workspace || !userId || !hash) {
    return null;
  }
  
  return {
    prefix: fullPrefix as 'tktt_live' | 'tktt_test',
    workspace,
    userId,
    hash,
    raw: token,
  };
}

// In-memory store for development/testing
export class InMemoryVirtualKeyStore implements VirtualKeyStore {
  private keys: Map<string, VirtualKeyLookupResult> = new Map();
  
  constructor(initialKeys?: VirtualKeyLookupResult[]) {
    if (initialKeys) {
      for (const key of initialKeys) {
        this.keys.set(key.realApiKey, key);
      }
    }
    
    // Add some demo keys
    this.addDemoKeys();
  }
  
  private addDemoKeys(): void {
    const demoKeys: VirtualKeyLookupResult[] = [
      {
        virtualKeyId: 'vkey_001',
        realApiKey: 'tktt_live_acme_jane_abc123def456',
        userId: 'user_jane',
        workspace: 'acme',
        costCenter: 'engineering',
        budgetLimit: 100.00,
        budgetRemaining: 87.50,
        budgetResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        rateLimitPerMinute: 100,
        enabled: true,
      },
      {
        virtualKeyId: 'vkey_002',
        realApiKey: 'tktt_live_acme_john_xyz789uvw012',
        userId: 'user_john',
        workspace: 'acme',
        costCenter: 'marketing',
        budgetLimit: 50.00,
        budgetRemaining: 12.30,
        budgetResetAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000), // 15 days
        rateLimitPerMinute: 50,
        enabled: true,
      },
      {
        virtualKeyId: 'vkey_003',
        realApiKey: 'tktt_live_globex_alice_qrs456tuv789',
        userId: 'user_alice',
        workspace: 'globex',
        costCenter: 'research',
        budgetLimit: 500.00,
        budgetRemaining: 450.00,
        budgetResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        rateLimitPerMinute: 200,
        enabled: true,
      },
      {
        virtualKeyId: 'vkey_004',
        realApiKey: 'tktt_live_acme_disabled_mno321pqr654',
        userId: 'user_disabled',
        workspace: 'acme',
        costCenter: 'deprecated',
        budgetLimit: 10.00,
        budgetRemaining: 5.00,
        budgetResetAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        rateLimitPerMinute: 10,
        enabled: false,
      },
    ];
    
    for (const key of demoKeys) {
      this.keys.set(key.realApiKey, key);
    }
  }
  
  async findByToken(token: string): Promise<VirtualKeyLookupResult | null> {
    // The token in the store is the full virtual key (without Bearer)
    return this.keys.get(token) || null;
  }
  
  addKey(key: VirtualKeyLookupResult): void {
    this.keys.set(key.realApiKey, key);
  }
  
  updateKey(token: string, updates: Partial<VirtualKeyLookupResult>): boolean {
    const existing = this.keys.get(token);
    if (!existing) {
      return false;
    }
    this.keys.set(token, { ...existing, ...updates });
    return true;
  }
  
  removeKey(token: string): boolean {
    return this.keys.delete(token);
  }
  
  listKeys(): VirtualKeyLookupResult[] {
    return Array.from(this.keys.values());
  }
}

// Postgres store interface for production use
export interface PostgresVirtualKeyStoreConfig {
  connectionString: string;
}

export class PostgresVirtualKeyStore implements VirtualKeyStore {
  private pool: pg.Pool;

  constructor(config: PostgresVirtualKeyStoreConfig) {
    this.pool = new pg.Pool({
      connectionString: config.connectionString,
      ssl: { rejectUnauthorized: false }
    });
  }
  
  async findByToken(token: string): Promise<VirtualKeyLookupResult | null> {
    const parts = token.split('_');
    if (parts.length < 5) return null;
    const workspace = parts[2];
    const userId = parts[3];

    try {
      const { rows } = await this.pool.query<{
        vk_id:              string;
        vk_public_id:       string;
        org_id:             string;
        workspace_id:       string | null;
        cost_center:        string;
        budget_cap_usd:     string | null;
        budget_period:      string;
        allowed_providers:  string[] | null;
        status:             string;
        real_api_key:       string | null;
        budget_used_usd:    string;
        enforcement_mode:   string | null;
        rate_limit_per_minute: number | null;
      }>(
        `
        SELECT
          vk.id                                        AS vk_id,
          vk.public_id::text                           AS vk_public_id,
          vk.organization_id::text                     AS org_id,
          vk.workspace_id::text                        AS workspace_id,
          COALESCE(ws.cost_center, 'default')          AS cost_center,
          vk.budget_cap_usd::text                      AS budget_cap_usd,
          vk.budget_period                             AS budget_period,
          vk.allowed_providers                         AS allowed_providers,
          vk.status                                    AS status,
          vk.metadata->>'real_api_key'                 AS real_api_key,
          vk.metadata->>'enforcement_mode'             AS enforcement_mode,
          COALESCE((vk.metadata->>'rate_limit_per_minute')::integer, 100) AS rate_limit_per_minute,
          COALESCE(
            (
              SELECT SUM(t.cost_usd)::text
              FROM   transactions t
              WHERE  t.virtual_key_id = vk.id
                AND  CASE vk.budget_period
                       WHEN 'daily'   THEN t.created_at >= date_trunc('day',  now())
                       WHEN 'monthly' THEN t.created_at >= date_trunc('month', now())
                       ELSE false
                     END
            ), '0'
          )                                            AS budget_used_usd
        FROM  virtual_keys  vk
        LEFT  JOIN workspaces ws ON ws.id = vk.workspace_id
        WHERE vk.key_prefix = $1
        LIMIT 1
        `,
        [token],
      );

      if (rows.length === 0) return null;
      const row = rows[0];

      const budgetLimit = row.budget_cap_usd ? parseFloat(row.budget_cap_usd) : 0;
      const budgetUsed = parseFloat(row.budget_used_usd);

      const now = new Date();
      let budgetResetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      if (row.budget_period === 'daily') {
        budgetResetAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      }

      return {
        virtualKeyId: row.vk_id,
        realApiKey: row.real_api_key || '',
        userId,
        workspace,
        costCenter: row.cost_center,
        budgetLimit,
        budgetRemaining: Math.max(0, budgetLimit - budgetUsed),
        budgetResetAt,
        rateLimitPerMinute: row.rate_limit_per_minute ?? 100,
        enabled: row.status === 'active',
        metadata: {
          enforcementMode: row.enforcement_mode ?? 'hard_cap',
          organizationId: row.org_id,
        }
      };
    } catch (err: any) {
      console.error('[PostgresVirtualKeyStore] Lookup error:', err.message);
      return null;
    }
  }
}
