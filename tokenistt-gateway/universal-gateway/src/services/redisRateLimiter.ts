import { getRedisClient } from './redis.js';

/**
 * Lua script for atomic sliding window rate limiting using Redis sorted sets (ZSET).
 * Keys:
 * - KEYS[1]: Rate limit key (e.g. gateway:ratelimit:sliding:<virtualKeyId>)
 * Arguments:
 * - ARGV[1]: Current timestamp in milliseconds (nowMs)
 * - ARGV[2]: Window size in seconds
 * - ARGV[3]: Maximum requests allowed in the window (limit)
 * 
 * Returns:
 * - Array: [allowed (0 or 1), remaining]
 */
const rateLimitLuaScript = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local clearBefore = now - (window * 1000)

  -- Clear historical request records outside of the sliding window
  redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
  
  -- Count requests currently in the sliding window
  local count = redis.call('ZCARD', key)
  local allowed = count < limit

  if allowed then
    -- Record the new request timestamp
    redis.call('ZADD', key, now, now)
    -- Refresh TTL so inactive keys eventually expire from Redis
    redis.call('EXPIRE', key, window)
  end

  local remaining = limit - count
  if allowed then
    remaining = remaining - 1
  end

  return { allowed and 1 or 0, remaining }
`;

export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Perform sliding window rate limit check using Redis Lua script.
 * If Redis is down, it fails open (returns allowed = true).
 */
export async function checkSlidingWindowRateLimit(
  virtualKeyId: string | bigint,
  limit: number,
  windowSeconds = 60
): Promise<RateLimitStatus> {
  const client = getRedisClient();
  const nowMs = Date.now();
  const resetAt = Math.floor(nowMs / 1000) + windowSeconds;

  if (!client) {
    // Fail-open
    return {
      allowed: true,
      remaining: limit,
      resetAt,
    };
  }

  const key = `gateway:ratelimit:sliding:${virtualKeyId.toString()}`;

  try {
    // Execute the Lua script atomically
    const result = await client.eval(
      rateLimitLuaScript,
      1, // Number of keys
      key, // KEYS[1]
      nowMs.toString(), // ARGV[1]
      windowSeconds.toString(), // ARGV[2]
      limit.toString() // ARGV[3]
    ) as [number, number];

    const allowed = result[0] === 1;
    const remaining = result[1];

    return {
      allowed,
      remaining,
      resetAt,
    };
  } catch (err: any) {
    console.error('[Redis Rate Limiter] Lua rate limit check failed:', err.message);
    // Fail-open
    return {
      allowed: true,
      remaining: limit,
      resetAt,
    };
  }
}
