import { RedisCache } from '../cache/redis.js';
import { 
  AttributionContext, 
  RateLimitResult 
} from '../types/index.js';

const RATE_LIMIT_PREFIX = 'ratelimit:';

export class RateLimiterService {
  private cache: RedisCache;
  private defaultLimit: number;
  private windowSeconds: number;
  
  constructor(
    cache: RedisCache,
    defaultLimit: number = 100,
    windowSeconds: number = 60
  ) {
    this.cache = cache;
    this.defaultLimit = defaultLimit;
    this.windowSeconds = windowSeconds;
  }
  
  /**
   * Check if a request is within rate limits
   * Uses sliding window algorithm
   */
  async checkRateLimit(
    context: AttributionContext
  ): Promise<RateLimitResult> {
    const limit = context.rateLimitPerMinute || this.defaultLimit;
    const key = `${RATE_LIMIT_PREFIX}${context.virtualKeyId}`;
    
    // Get current count
    const currentCount = await this.cache.increment(key, this.windowSeconds);
    
    // Calculate reset time (end of current window)
    const resetAt = Math.floor(Date.now() / 1000) + this.windowSeconds;
    const remaining = Math.max(0, limit - currentCount);
    
    const result: RateLimitResult = {
      allowed: currentCount <= limit,
      remaining,
      resetAt,
    };
    
    if (currentCount > limit) {
      // Calculate retry-after based on window
      const retryAfter = this.windowSeconds;
      result.retryAfter = retryAfter;
    }
    
    return result;
  }
  
  /**
   * Get current rate limit status without incrementing
   */
  async getRateLimitStatus(
    context: AttributionContext
  ): Promise<RateLimitResult> {
    const limit = context.rateLimitPerMinute || this.defaultLimit;
    const key = `${RATE_LIMIT_PREFIX}${context.virtualKeyId}`;
    
    const data = await this.cache.getWithExpiry(key);
    
    if (!data) {
      return {
        allowed: true,
        remaining: limit,
        resetAt: Math.floor(Date.now() / 1000) + this.windowSeconds,
      };
    }
    
    const currentCount = (data.value as number) || 0;
    const remaining = Math.max(0, limit - currentCount);
    
    return {
      allowed: remaining > 0,
      remaining,
      resetAt: Math.floor(Date.now() / 1000) + data.ttl,
    };
  }
  
  /**
   * Reset rate limit for a virtual key
   */
  async resetRateLimit(context: AttributionContext): Promise<void> {
    const key = `${RATE_LIMIT_PREFIX}${context.virtualKeyId}`;
    await this.cache.delete(key);
  }
  
  /**
   * Set a custom rate limit for a virtual key
   */
  async setRateLimit(
    context: AttributionContext,
    limit: number
  ): Promise<void> {
    // This would typically update the database
    // For now, we just update the context
    context.rateLimitPerMinute = limit;
  }
  
  /**
   * Get rate limit configuration
   */
  getConfig(): { defaultLimit: number; windowSeconds: number } {
    return {
      defaultLimit: this.defaultLimit,
      windowSeconds: this.windowSeconds,
    };
  }
  
  /**
   * Token bucket algorithm implementation
   * Returns how many requests can be made immediately
   */
  async getAvailableTokens(
    context: AttributionContext
  ): Promise<{ tokens: number; refillTime: number }> {
    const limit = context.rateLimitPerMinute || this.defaultLimit;
    const key = `${RATE_LIMIT_PREFIX}${context.virtualKeyId}`;
    
    const data = await this.cache.getWithExpiry(key);
    
    if (!data) {
      return {
        tokens: limit,
        refillTime: 0,
      };
    }
    
    const currentCount = (data.value as number) || 0;
    const tokens = Math.max(0, limit - currentCount);
    const refillTime = data.ttl > 0 ? Date.now() + (data.ttl * 1000) : Date.now();
    
    return {
      tokens,
      refillTime,
    };
  }
}
