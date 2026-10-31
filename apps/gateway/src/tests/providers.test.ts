import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveBaseUrl, validateProviderKey } from '../routes/providers.js';

describe('Provider Validation & Base URL Resolution', () => {
  it('should resolve default base URLs correctly', () => {
    assert.strictEqual(resolveBaseUrl('groq'), 'https://api.groq.com/openai/v1');
    assert.strictEqual(resolveBaseUrl('openai', undefined, 'gsk_123'), 'https://api.groq.com/openai/v1');
    assert.strictEqual(resolveBaseUrl('together'), 'https://api.together.xyz/v1');
    assert.strictEqual(resolveBaseUrl('mistral'), 'https://api.mistral.ai/v1');
    assert.strictEqual(resolveBaseUrl('anthropic'), 'https://api.anthropic.com/v1');
    assert.strictEqual(resolveBaseUrl('openai'), 'https://api.openai.com/v1');
  });

  it('should respect custom base URL overrides', () => {
    assert.strictEqual(
      resolveBaseUrl('openai', 'https://my-custom-proxy.internal/v1/'),
      'https://my-custom-proxy.internal/v1'
    );
  });

  it('should reject invalid keys with authentication error', async () => {
    // Intercept or test with an intentionally invalid mock key against fake base URL
    const res = await validateProviderKey('openai', 'sk-invalid-mock-key', 'https://127.0.0.1:9999');
    assert.strictEqual(res.valid, false);
    assert.ok(res.error);
  });
});

