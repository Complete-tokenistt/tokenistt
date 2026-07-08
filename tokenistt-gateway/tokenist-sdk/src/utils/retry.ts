import { APIError, RateLimitError } from '../types/index.js';

export interface RetryConfig {
  maxRetries: number;
  retryDelay: number;
  backoffFactor: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  retryDelay: 1000,
  backoffFactor: 2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const { maxRetries, retryDelay, backoffFactor } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };
  
  let lastError: Error | undefined;
  let currentDelay = retryDelay;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error as Error;
      
      // Don't retry on certain errors
      if (error instanceof APIError) {
        // Don't retry on authentication errors
        if (error.status === 401 || error.status === 403) {
          throw error;
        }
        
        // Retry on rate limit errors with backoff
        if (error instanceof RateLimitError) {
          // Use Retry-After header if available
          const retryAfter = error.headers?.['retry-after'];
          if (retryAfter) {
            currentDelay = parseInt(retryAfter, 10) * 1000;
          }
        }
        
        // Retry on 500-level errors
        if (error.status && error.status >= 500 && attempt < maxRetries) {
          await sleep(currentDelay);
          currentDelay *= backoffFactor;
          continue;
        }
      }
      
      // Don't retry on non-API errors
      if (!(error instanceof APIError) && attempt < maxRetries) {
        await sleep(currentDelay);
        currentDelay *= backoffFactor;
        continue;
      }
      
      throw error;
    }
  }
  
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof APIError) {
    // Retry on rate limits
    if (error instanceof RateLimitError) {
      return true;
    }
    
    // Retry on 500-level errors
    if (error.status && error.status >= 500) {
      return true;
    }
    
    // Retry on 429 without explicit code
    if (error.status === 429) {
      return true;
    }
  }
  
  return false;
}
