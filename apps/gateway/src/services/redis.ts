import { Redis } from 'ioredis';
import { AuthContext } from '../db/auth.js';

let redisClient: Redis | null = null;
let isConnected = false;

export function getRedisClient(): Redis | null {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  
  if (!redisClient) {
    try {
      redisClient = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (times > 3) {
            console.warn('[Redis] Connection failed. Falling back to direct database.');
            return null; // Stop retrying
          }
          return Math.min(times * 100, 1000);
        }
      });
      
      redisClient.on('connect', () => {
        isConnected = true;
        console.log('[Redis] Connected successfully.');
      });
      
      redisClient.on('error', (err) => {
        isConnected = false;
        console.error('[Redis] Connection error:', err.message);
      });
      
      redisClient.on('close', () => {
        isConnected = false;
        console.log('[Redis] Connection closed.');
      });
      
      redisClient.connect().catch((err) => {
        console.warn('[Redis] Initial connection attempt failed:', err.message);
      });
    } catch (err: any) {
      console.error('[Redis] Failed to initialize client:', err.message);
    }
  }
  
  return isConnected ? redisClient : null;
}

// Custom JSON serialization supporting BigInt
function serializeContext(context: AuthContext): string {
  return JSON.stringify(context, (key, value) => {
    if (typeof value === 'bigint') {
      return { __type: 'bigint', value: value.toString() };
    }
    return value;
  });
}

function deserializeContext(json: string): AuthContext {
  return JSON.parse(json, (key, value) => {
    if (value && typeof value === 'object' && value.__type === 'bigint') {
      return BigInt(value.value);
    }
    return value;
  });
}

const KEY_PREFIX = 'gateway:vk:';
const DEFAULT_TTL_SECONDS = 300; // 5 minutes

/**
 * Attempt to retrieve virtual key context from Redis cache.
 */
export async function getCachedVirtualKey(token: string): Promise<AuthContext | null> {
  const client = getRedisClient();
  if (!client) return null;
  
  try {
    const cached = await client.get(`${KEY_PREFIX}${token}`);
    if (cached) {
      return deserializeContext(cached);
    }
  } catch (err: any) {
    console.error('[Redis] Cache get error:', err.message);
  }
  
  return null;
}

/**
 * Cache virtual key context in Redis.
 */
export async function setCachedVirtualKey(
  token: string,
  context: AuthContext,
  ttlSeconds = DEFAULT_TTL_SECONDS
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  
  try {
    const serialized = serializeContext(context);
    await client.setex(`${KEY_PREFIX}${token}`, ttlSeconds, serialized);
  } catch (err: any) {
    console.error('[Redis] Cache set error:', err.message);
  }
}

/**
 * Invalidate a virtual key in the Redis cache.
 */
export async function invalidateCachedVirtualKey(token: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  
  try {
    await client.del(`${KEY_PREFIX}${token}`);
  } catch (err: any) {
    console.error('[Redis] Cache delete error:', err.message);
  }
}

const RATE_LIMIT_PREFIX = 'gateway:ratelimit:';

export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Distributed rate limiter using Redis atomic transactions.
 */
export async function checkRateLimit(
  virtualKeyId: string | bigint,
  limit: number,
  windowSeconds = 60
): Promise<RateLimitStatus> {
  const client = getRedisClient();
  // If Redis is unavailable, fail open (allow the request)
  if (!client) {
    return {
      allowed: true,
      remaining: limit,
      resetAt: Math.floor(Date.now() / 1000) + windowSeconds,
    };
  }
  
  const key = `${RATE_LIMIT_PREFIX}${virtualKeyId.toString()}`;
  try {
    const multi = client.multi();
    multi.incr(key);
    multi.ttl(key);
    const results = await multi.exec();
    
    if (!results) {
      throw new Error('Transaction execution returned null');
    }
    
    const currentCount = (results[0]?.[1] as number) || 1;
    let ttl = (results[1]?.[1] as number) || -1;
    
    // If the key has no expiry, set it now
    if (ttl === -1) {
      await client.expire(key, windowSeconds);
      ttl = windowSeconds;
    }
    
    const remaining = Math.max(0, limit - currentCount);
    const resetAt = Math.floor(Date.now() / 1000) + (ttl > 0 ? ttl : windowSeconds);
    
    return {
      allowed: currentCount <= limit,
      remaining,
      resetAt,
    };
  } catch (err: any) {
    console.error('[Redis] Rate limiter error:', err.message);
    // Fail-open
    return {
      allowed: true,
      remaining: limit,
      resetAt: Math.floor(Date.now() / 1000) + windowSeconds,
    };
  }
}

export const INCREMENT_BUDGET_SCRIPT = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local default_ttl = tonumber(ARGV[2])
local cached = redis.call('GET', key)
if not cached then return nil end
local ctx = cjson.decode(cached)
local current = tonumber(ctx['budgetUsedUsd']) or 0
ctx['budgetUsedUsd'] = current + amount
local ttl = redis.call('TTL', key)
if ttl < 0 then ttl = default_ttl end
redis.call('SETEX', key, ttl, cjson.encode(ctx))
return tostring(ctx['budgetUsedUsd'])
`;

/**
 * Increment the budgetUsedUsd for a cached virtual key context atomically.
 */
export async function incrementCachedBudget(
  token: string,
  amount: number
): Promise<number | null> {
  const client = getRedisClient();
  if (!client) return null;
  
  try {
    const key = `${KEY_PREFIX}${token}`;
    const result = await client.eval(
      INCREMENT_BUDGET_SCRIPT,
      1,
      key,
      amount.toString(),
      DEFAULT_TTL_SECONDS.toString()
    ) as string | null;

    return result ? parseFloat(result) : null;
  } catch (err: any) {
    console.error('[Redis] Increment cached budget error:', err.message);
    return null;
  }
}

const BUDGET_RESERVE_PREFIX = 'gateway:budget_reserve:';

export interface BudgetReservationResult {
  allowed: boolean;
  usedAfter: number;
}

/**
 * Atomically reserves `estimatedCostUsd` against a budget key using Redis Lua script.
 * 
 * IMPORTANT: When the Redis key is missing (expired or server restart), this function
 * seeds the key with `existingSpendUsd` (the authoritative spend from PostgreSQL) so
 * that the reservation correctly reflects current actual spend.
 *
 * The seed + increment is atomic inside the Lua script, preventing the race where two
 * concurrent requests both see an empty key and each initialise it independently.
 *
 * If current + estimated > cap, rolls back and returns allowed: false.
 */
export async function atomicBudgetReserve(
  rawToken: string,
  estimatedCostUsd: number,
  budgetCapUsd: number,
  period: 'daily' | 'monthly' | 'none',
  existingSpendUsd = 0,
): Promise<BudgetReservationResult> {
  const client = getRedisClient();

  // period=none means no budget cap — always allow regardless of Redis availability
  if (period === 'none') {
    return { allowed: true, usedAfter: existingSpendUsd };
  }

  if (!client) {
    // Redis unavailable: fall back to DB-based check
    const wouldExceed = existingSpendUsd + estimatedCostUsd > budgetCapUsd;
    return {
      allowed: !wouldExceed,
      usedAfter: existingSpendUsd + (wouldExceed ? 0 : estimatedCostUsd),
    };
  }


  const periodKey = period === 'daily'
    ? new Date().toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 7);

  const key = `${BUDGET_RESERVE_PREFIX}${rawToken}:${periodKey}`;
  const ttlSeconds = period === 'daily' ? 86400 : 2678400; // 1 day or 31 days

  // Atomic Lua script:
  // 1. If the key does NOT exist, seed it with existingSpendUsd (from DB) using SETNX.
  //    This is atomic: only the first concurrent caller seeds it; others skip SETNX.
  // 2. Add the estimated cost to the key.
  // 3. Set TTL if not already set.
  // 4. If result > cap, roll back and deny.
  const luaScript = `
    local key = KEYS[1]
    local amount = tonumber(ARGV[1])
    local cap = tonumber(ARGV[2])
    local ttl = tonumber(ARGV[3])
    local base_spend = tonumber(ARGV[4])
    -- Seed the key atomically if it doesn't exist yet (DB authoritative spend as floor)
    if redis.call('EXISTS', key) == 0 then
      redis.call('SET', key, tostring(base_spend), 'EX', ttl, 'NX')
    end
    local current = tonumber(redis.call('INCRBYFLOAT', key, amount))
    if redis.call('TTL', key) == -1 then
      redis.call('EXPIRE', key, ttl)
    end
    if current > cap then
      redis.call('INCRBYFLOAT', key, -amount)
      return {0, tostring(current - amount)}
    end
    return {1, tostring(current)}
  `;

  try {
    const result = (await client.eval(
      luaScript,
      1,
      key,
      estimatedCostUsd.toString(),
      budgetCapUsd.toString(),
      ttlSeconds.toString(),
      existingSpendUsd.toString(),
    )) as [number, string];

    return {
      allowed: result[0] === 1,
      usedAfter: parseFloat(result[1] || '0'),
    };
  } catch (err: any) {
    console.error('[Redis] atomicBudgetReserve error:', err.message);
    // Fail-safe: fall back to DB-based check rather than fail-open
    const wouldExceed = existingSpendUsd + estimatedCostUsd > budgetCapUsd;
    return {
      allowed: !wouldExceed,
      usedAfter: existingSpendUsd + (wouldExceed ? 0 : estimatedCostUsd),
    };
  }
}


/**
 * Adjusts budget reservation once actual cost is determined.
 */
export async function adjustBudgetReservation(
  rawToken: string,
  estimatedCostUsd: number,
  actualCostUsd: number,
  period: 'daily' | 'monthly' | 'none'
): Promise<void> {
  const client = getRedisClient();
  if (!client || period === 'none') return;

  const delta = actualCostUsd - estimatedCostUsd;
  if (Math.abs(delta) < 0.000001) return;

  const periodKey = period === 'daily'
    ? new Date().toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 7);

  const key = `${BUDGET_RESERVE_PREFIX}${rawToken}:${periodKey}`;

  try {
    await client.incrbyfloat(key, delta);
  } catch (err: any) {
    console.error('[Redis] adjustBudgetReservation error:', err.message);
  }
}

