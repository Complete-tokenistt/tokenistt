import {
  OpenAIChatCompletionRequest,
  ProviderResponse,
  OpenAIMessage,
} from '../types/index.js';
import { BaseProviderAdapter, estimateRequestTokens } from './base.js';

/**
 * Deterministic offline provider for `tokenistt dev`, demos and CI.
 * Enabled with MOCK_PROVIDER=1. Route to it with the `mock:` model prefix.
 *   - echoes the last user message
 *   - `mock:fail`    → 500 (exercises failover / circuit breaker)
 *   - `mock:limited` → 429 (exercises BYOK key failover)
 * Token counts are estimated from text length, so costs are stable across runs.
 */
export class MockAdapter extends BaseProviderAdapter {
  name = 'mock';

  canHandle(model: string): boolean {
    return model.toLowerCase().startsWith('mock:');
  }

  translateRequest(request: OpenAIChatCompletionRequest): unknown {
    return { model: request.model.replace(/^mock:/i, ''), messages: request.messages };
  }

  async callProvider(translated: any, apiKeyOverride?: string | null): Promise<ProviderResponse> {
    if (translated.model === 'fail') throw new Error('Mock error (500): simulated provider outage');
    if (translated.model === 'limited' && apiKeyOverride !== 'mock-good-key') {
      throw new Error('Mock rate limit exceeded: simulated 429');
    }
    const messages: OpenAIMessage[] = translated.messages ?? [];
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const text = `mock reply: ${typeof lastUser?.content === 'string' ? lastUser.content : ''}`.slice(0, 2000);
    return {
      content: text,
      stopReason: 'stop',
      inputTokens: Math.ceil(estimateRequestTokens(messages)),
      outputTokens: Math.max(1, Math.ceil(text.length / 4)),
      modelId: translated.model,
    };
  }

  estimateTokens(messages: OpenAIMessage[]): { inputTokens: number } {
    return { inputTokens: Math.ceil(estimateRequestTokens(messages)) };
  }
}
