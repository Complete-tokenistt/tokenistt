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
  // This is a placeholder - implement with actual pg client in production
  constructor(_config: PostgresVirtualKeyStoreConfig) {
    throw new Error('Postgres store not implemented. Use InMemoryVirtualKeyStore for development.');
  }
  
  async findByToken(_token: string): Promise<VirtualKeyLookupResult | null> {
    throw new Error('Postgres store not implemented');
  }
}
