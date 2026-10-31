import { describe, it } from 'node:test';
import assert from 'node:assert';
import { withRetry } from '../services/retry.js';
import { GatewayError } from '../types/index.js';

describe('Retry Resiliency Engine', () => {
  it('should succeed immediately if no error occurs', async () => {
    let attempts = 0;
    const res = await withRetry(async () => {
      attempts++;
      return 'success';
    });
    assert.strictEqual(res, 'success');
    assert.strictEqual(attempts, 1);
  });

  it('should retry on 500 error and succeed on subsequent attempt', async () => {
    let attempts = 0;
    const res = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new GatewayError('Provider 500 Server Error', 500, 'openai');
        }
        return 'recovered';
      },
      { initialDelayMs: 10, maxDelayMs: 50, maxRetries: 3 }
    );

    assert.strictEqual(res, 'recovered');
    assert.strictEqual(attempts, 3);
  });

  it('should NOT retry on 401 Unauthorized client errors', async () => {
    let attempts = 0;
    await assert.rejects(
      async () => {
        await withRetry(async () => {
          attempts++;
          throw new GatewayError('Invalid API Key', 401, 'anthropic');
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 401);
        return true;
      }
    );

    assert.strictEqual(attempts, 1, 'Should fail immediately without retrying on 401');
  });

  it('should fail after exhausting maxRetries on persistent 429 errors', async () => {
    let attempts = 0;
    await assert.rejects(
      async () => {
        await withRetry(
          async () => {
            attempts++;
            throw new GatewayError('Rate limit exceeded', 429, 'bedrock');
          },
          { initialDelayMs: 10, maxDelayMs: 50, maxRetries: 2 }
        );
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 429);
        return true;
      }
    );

    assert.strictEqual(attempts, 3, 'Initial attempt + 2 retries = 3 attempts total');
  });
});

