/**
 * services/retry.ts — Resiliency and retry handler with exponential backoff & full jitter.
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const initialDelay = options?.initialDelayMs ?? 400;
  const maxDelay = options?.maxDelayMs ?? 4000;
  const backoffFactor = options?.backoffFactor ?? 2;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const statusCode = err.statusCode || err.response?.status || err.status;

      // Never retry non-retriable client errors
      const isRetriable = !statusCode || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
      if (!isRetriable || attempt > maxRetries) {
        throw err;
      }

      // Exponential backoff with jitter
      const expDelay = Math.min(maxDelay, initialDelay * Math.pow(backoffFactor, attempt - 1));
      const jitter = Math.random() * expDelay;
      const delayMs = Math.floor(expDelay / 2 + jitter / 2);

      console.warn(
        `[Retry 🔄] Attempt ${attempt}/${maxRetries} failed with error (${err.message || statusCode}). Retrying in ${delayMs}ms...`
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

