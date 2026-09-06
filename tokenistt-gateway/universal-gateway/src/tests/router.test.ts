import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SmartRouter } from '../services/router.js';
import { GatewayError, ProviderType } from '../types/index.js';

describe('SmartRouter Cross-Provider Failover', () => {
  it('should translate model when failing over from Anthropic to OpenAI', async () => {
    let calledProvider = '';
    let receivedModel = '';

    const mockGateway = {
      detectProvider: () => 'anthropic' as ProviderType,
      getAvailableProviders: () => ['anthropic', 'openai'] as ProviderType[],
      handleChatCompletion: async (req: any, provider: ProviderType) => {
        calledProvider = provider;
        if (provider === 'anthropic') {
          throw new GatewayError('Anthropic 503 Overloaded', 503, 'anthropic');
        }
        receivedModel = req.model;
        return {
          id: 'chatcmpl-123',
          object: 'chat.completion',
          created: 1700000000,
          model: req.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from OpenAI' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          _tokenistt: { actual_cost: 0.0001, latency_ms: 150, model_used: req.model, provider }
        };
      }
    } as any;

    const router = new SmartRouter(mockGateway, {
      enableFailover: true,
      fallbackChain: {
        anthropic: ['openai'],
        openai: ['anthropic'],
        azure: ['openai'],
        bedrock: ['anthropic'],
      }
    });

    const response = await router.handleChatCompletion({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'Hi' }]
    });

    assert.strictEqual(calledProvider, 'openai');
    assert.strictEqual(receivedModel, 'gpt-4o', 'Claude 3.5 Sonnet should translate to GPT-4o on OpenAI failover');
    assert.strictEqual(response._tokenistt?.failover_used, true);
    assert.strictEqual(response._tokenistt?.original_provider, 'anthropic');
    assert.strictEqual(response._tokenistt?.fallback_model, 'gpt-4o');
  });

  it('should NOT failover on client errors (400, 401, 403)', async () => {
    let callCount = 0;

    const mockGateway = {
      detectProvider: () => 'openai' as ProviderType,
      getAvailableProviders: () => ['openai', 'anthropic'] as ProviderType[],
      handleChatCompletion: async () => {
        callCount++;
        throw new GatewayError('Invalid API Key', 401, 'openai');
      }
    } as any;

    const router = new SmartRouter(mockGateway, { enableFailover: true });

    await assert.rejects(
      async () => {
        await router.handleChatCompletion({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 401);
        return true;
      }
    );

    assert.strictEqual(callCount, 1, 'Should immediately reject on 401 without attempting fallback');
  });

  it('should throw ALL_PROVIDERS_FAILED if all candidates fail', async () => {
    const mockGateway = {
      detectProvider: () => 'openai' as ProviderType,
      getAvailableProviders: () => ['openai', 'anthropic'] as ProviderType[],
      handleChatCompletion: async () => {
        throw new GatewayError('Internal server error', 500, 'openai');
      }
    } as any;

    const router = new SmartRouter(mockGateway, { enableFailover: true });

    await assert.rejects(
      async () => {
        await router.handleChatCompletion({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hi' }]
        });
      },
      /ALL_PROVIDERS_FAILED|All attempted providers failed/
    );
  });
});
