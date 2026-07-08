import { Redis } from 'ioredis';
import type { FinOpsConfig } from '../types/index.js';

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class RedisCache {
  private client: Redis | null = null;
  private keyPrefix: string;
  private connected: boolean = false;
  
  // In-memory fallback cache when Redis is not available
  private memoryCache: Map<string, CacheEntry<unknown>> = new Map();
  
  constructor(config?: FinOpsConfig['redis']) {
    this.keyPrefix = config?.keyPrefix || 'finops:';
    
    if (config?.host && config?.port) {
      this.client = new Redis({
        host: config.host,
        port: config.port,
        password: config.password,
        db: config.db || 0,
        lazyConnect: true,
        retryStrategy: (times: number) => {
          if (times > 3) {
            console.warn('Redis connection failed, using in-memory cache');
            return null;
          }
          return Math.min(times * 100, 1000);
        },
      });
      
      this.client.on('connect', () => {
        this.connected = true;
        console.log('Redis connected');
      });
      
      this.client.on('error', (err: Error) => {
        this.connected = false;
        console.error('Redis error:', err.message);
      });
      
      this.client.on('close', () => {
        this.connected = false;
      });
    }
  }
  
  async connect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.connect();
      } catch (err) {
        console.warn('Redis connection failed, using in-memory cache');
      }
    }
  }
  
  isConnected(): boolean {
    return this.connected;
  }
  
  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
  
  async get<T>(key: string): Promise<T | null> {
    const fullKey = this.getKey(key);
    
    if (this.client && this.connected) {
      try {
        const data = await this.client.get(fullKey);
        if (data) {
          const entry = JSON.parse(data) as CacheEntry<T>;
          if (entry.expiresAt > Date.now()) {
            return entry.value;
          }
          await this.client.del(fullKey);
        }
      } catch (err) {
        console.error('Redis get error:', err);
      }
    }
    
    // Fallback to memory cache
    const memoryEntry = this.memoryCache.get(fullKey) as CacheEntry<T> | undefined;
    if (memoryEntry && memoryEntry.expiresAt > Date.now()) {
      return memoryEntry.value;
    }
    this.memoryCache.delete(fullKey);
    
    return null;
  }
  
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const fullKey = this.getKey(key);
    const entry: CacheEntry<T> = {
      value,
      expiresAt: Date.now() + (ttlSeconds * 1000),
    };
    
    if (this.client && this.connected) {
      try {
        await this.client.setex(fullKey, ttlSeconds, JSON.stringify(entry));
      } catch (err) {
        console.error('Redis set error:', err);
      }
    }
    
    // Always update memory cache as fallback
    this.memoryCache.set(fullKey, entry as CacheEntry<unknown>);
    
    // Clean up old entries periodically
    if (this.memoryCache.size > 10000) {
      this.cleanupMemoryCache();
    }
  }
  
  async delete(key: string): Promise<void> {
    const fullKey = this.getKey(key);
    
    if (this.client && this.connected) {
      try {
        await this.client.del(fullKey);
      } catch (err) {
        console.error('Redis delete error:', err);
      }
    }
    
    this.memoryCache.delete(fullKey);
  }
  
  async increment(key: string, ttlSeconds: number): Promise<number> {
    const fullKey = this.getKey(key);
    
    if (this.client && this.connected) {
      try {
        const multi = this.client.multi();
        multi.incr(fullKey);
        multi.expire(fullKey, ttlSeconds);
        const results = await multi.exec();
        return (results?.[0]?.[1] as number) || 0;
      } catch (err) {
        console.error('Redis increment error:', err);
      }
    }
    
    // Memory cache fallback
    const entry = this.memoryCache.get(fullKey) as CacheEntry<number> | undefined;
    const currentValue = (entry?.value as number) || 0;
    const newValue = currentValue + 1;
    this.memoryCache.set(fullKey, {
      value: newValue,
      expiresAt: Date.now() + (ttlSeconds * 1000),
    });
    
    return newValue;
  }
  
  async decrement(key: string, amount: number): Promise<number> {
    const fullKey = this.getKey(key);
    
    if (this.client && this.connected) {
      try {
        const multi = this.client.multi();
        multi.decrby(fullKey, amount);
        multi.persist(fullKey);
        const results = await multi.exec();
        return (results?.[0]?.[1] as number) || 0;
      } catch (err) {
        console.error('Redis decrement error:', err);
      }
    }
    
    const entry = this.memoryCache.get(fullKey) as CacheEntry<number> | undefined;
    const currentValue = (entry?.value as number) || 0;
    const newValue = Math.max(0, currentValue - amount);
    this.memoryCache.set(fullKey, {
      value: newValue,
      expiresAt: Date.now() + (24 * 60 * 60 * 1000),
    });
    
    return newValue;
  }
  
  async getWithExpiry(key: string): Promise<{ value: unknown; ttl: number } | null> {
    const fullKey = this.getKey(key);
    
    if (this.client && this.connected) {
      try {
        const data = await this.client.get(fullKey);
        const ttl = await this.client.ttl(fullKey);
        if (data && ttl > 0) {
          const entry = JSON.parse(data);
          return { value: entry.value, ttl };
        }
      } catch (err) {
        console.error('Redis getWithExpiry error:', err);
      }
    }
    
    const entry = this.memoryCache.get(fullKey);
    if (entry) {
      const ttl = Math.ceil((entry.expiresAt - Date.now()) / 1000);
      if (ttl > 0) {
        return { value: entry.value, ttl };
      }
    }
    
    return null;
  }
  
  private cleanupMemoryCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expiresAt < now) {
        this.memoryCache.delete(key);
      }
    }
  }
  
  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
    }
    this.memoryCache.clear();
  }
}
