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
