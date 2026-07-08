import axios, { AxiosInstance } from 'axios';
import { 
  OpenAIChatCompletionRequest, 
  ProviderResponse,
  OpenAIMessage 
} from '../types/index.js';
import { BaseProviderAdapter, estimateRequestTokens } from './base.js';

export class OpenAIAdapter extends BaseProviderAdapter {
  name = 'openai';
  private defaultClient: AxiosInstance | null = null;
  private defaultApiKey: string = '';

  constructor(apiKey?: string) {
    super();
    if (apiKey) {
      this.setApiKey(apiKey);
    }
  }

  setApiKey(apiKey: string): void {
    this.defaultApiKey = apiKey;
    this.defaultClient = axios.create({
      baseURL: 'https://api.openai.com/v1',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });
  }

  canHandle(model: string): boolean {
    const normalizedModel = model.toLowerCase();
    return (
      normalizedModel.includes('openai') ||
      normalizedModel.includes('gpt-') ||
      normalizedModel.startsWith('o1') ||
      normalizedModel.startsWith('o3')
    );
  }

  translateRequest(request: OpenAIChatCompletionRequest): unknown {
    // OpenAI is our base format, so we can pass most fields through directly.
    return {
      model: request.model.replace(/^openai:/, ''), // Strip provider prefix if present
      messages: request.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        name: msg.name,
        tool_calls: msg.tool_calls,
        tool_call_id: msg.tool_call_id,
      })),
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens,
      tools: request.tools,
      tool_choice: request.tool_choice,
      stream: request.stream,
      stop: request.stop,
      presence_penalty: request.presence_penalty,
      frequency_penalty: request.frequency_penalty,
    };
  }

  async callProvider(
    translateRequest: any,
    apiKeyOverride?: string | null
  ): Promise<ProviderResponse> {
    // ── Resolve client & api key (BYOK key swap) ─────────────────────────────
    let client = this.defaultClient;
    let apiKey = apiKeyOverride || this.defaultApiKey || process.env.OPENAI_API_KEY;

    if (apiKeyOverride) {
      client = axios.create({
        baseURL: 'https://api.openai.com/v1',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKeyOverride}`,
        },
      });
    }

    if (!client && apiKey) {
      client = axios.create({
        baseURL: 'https://api.openai.com/v1',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      });
    }

    if (!client) {
      throw new Error('OpenAI API credentials not configured');
    }

    try {
      const response = await client.post('/chat/completions', translateRequest);
      const data = response.data;
      const choice = data.choices?.[0];

      let stopReason: 'stop' | 'length' | 'content_filter' = 'stop';
      if (choice?.finish_reason === 'stop') {
        stopReason = 'stop';
      } else if (choice?.finish_reason === 'length') {
        stopReason = 'length';
      } else if (choice?.finish_reason === 'content_filter') {
        stopReason = 'content_filter';
      }

      return {
        content: choice?.message?.content || '',
        stopReason,
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        modelId: data.model || translateRequest.model,
        rawResponse: data,
      };
    } catch (error: any) {
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.error?.message || error.response.data?.message || 'Unknown error';

        if (status === 401) {
          throw new Error(`OpenAI authentication failed: ${message}`);
        } else if (status === 429) {
          throw new Error(`OpenAI rate limit exceeded: ${message}`);
        }

        throw new Error(`OpenAI error (${status}): ${message}`);
      }
      throw error;
    }
  }

  parseResponse(response: ProviderResponse) {
    return {
      content: response.content,
      finishReason: response.stopReason,
    };
  }

  estimateTokens(messages: OpenAIMessage[], model: string): { inputTokens: number } {
    return {
      inputTokens: estimateRequestTokens(messages),
    };
  }
}
