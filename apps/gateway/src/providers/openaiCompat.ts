import axios from 'axios';
import {
  OpenAIChatCompletionRequest,
  ProviderResponse,
  OpenAIMessage,
  ProviderType,
} from '../types/index.js';
import { BaseProviderAdapter, estimateRequestTokens } from './base.js';

export interface OpenAICompatConfig {
  /** Registry key / ProviderType */
  name: ProviderType;
  /** Human label used in error messages */
  label: string;
  defaultBaseUrl: string;
  /** Env var that overrides the base URL */
  baseUrlEnv: string;
  /** Env var holding the default API key */
  apiKeyEnv: string;
  /** Model-name prefix that routes here, e.g. "groq:" */
  prefix: string;
  /** Extra substrings in a model name that also route here */
  modelHints?: string[];
  /** Local servers (Ollama) accept requests without a key */
  keyOptional?: boolean;
}

/**
 * Generic adapter for any provider exposing an OpenAI-compatible
 * /chat/completions endpoint (Groq, Together, Ollama, Gemini, ...).
 * Provider specifics live in the config object, never in callers.
 */
export class OpenAICompatAdapter extends BaseProviderAdapter {
  name: string;
  private apiKey = '';

  constructor(private readonly cfg: OpenAICompatConfig, apiKey?: string) {
    super();
    this.name = cfg.name;
    this.apiKey = apiKey || process.env[cfg.apiKeyEnv] || '';
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  get baseUrl(): string {
    return (process.env[this.cfg.baseUrlEnv] || this.cfg.defaultBaseUrl).replace(/\/+$/, '');
  }

  canHandle(model: string): boolean {
    const m = model.toLowerCase();
    return (
      m.startsWith(this.cfg.prefix) ||
      (this.cfg.modelHints ?? []).some(h => m.includes(h))
    );
  }

  translateRequest(request: OpenAIChatCompletionRequest): unknown {
    const prefix = new RegExp(`^${this.cfg.prefix}`, 'i');
    return {
      model: request.model.replace(prefix, ''),
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

  async callProvider(translated: any, apiKeyOverride?: string | null): Promise<ProviderResponse> {
    const key = apiKeyOverride || this.apiKey;
    if (!key && !this.cfg.keyOptional) {
      throw new Error(`${this.cfg.label} API credentials not configured`);
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;

    try {
      const { data } = await axios.post(`${this.baseUrl}/chat/completions`, translated, { headers });
      const choice = data.choices?.[0];
      const fr = choice?.finish_reason;
      const stopReason: ProviderResponse['stopReason'] =
        fr === 'length' ? 'length' : fr === 'content_filter' ? 'content_filter' : 'stop';
      return {
        content: choice?.message?.content || '',
        stopReason,
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        modelId: data.model || translated.model,
        rawResponse: data,
      };
    } catch (error: any) {
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.error?.message || error.response.data?.message || 'Unknown error';
        if (status === 401) throw new Error(`${this.cfg.label} authentication failed: ${message}`);
        if (status === 429) throw new Error(`${this.cfg.label} rate limit exceeded: ${message}`);
        throw new Error(`${this.cfg.label} error (${status}): ${message}`);
      }
      throw error;
    }
  }

  estimateTokens(messages: OpenAIMessage[], _model: string): { inputTokens: number } {
    return { inputTokens: estimateRequestTokens(messages) };
  }
}

export const GROQ_CONFIG: OpenAICompatConfig = {
  name: 'groq',
  label: 'Groq',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  baseUrlEnv: 'GROQ_BASE_URL',
  apiKeyEnv: 'GROQ_API_KEY',
  prefix: 'groq:',
};

export const TOGETHER_CONFIG: OpenAICompatConfig = {
  name: 'together',
  label: 'Together AI',
  defaultBaseUrl: 'https://api.together.xyz/v1',
  baseUrlEnv: 'TOGETHER_BASE_URL',
  apiKeyEnv: 'TOGETHER_API_KEY',
  prefix: 'together:',
};

export const OLLAMA_CONFIG: OpenAICompatConfig = {
  name: 'ollama',
  label: 'Ollama',
  defaultBaseUrl: 'http://localhost:11434/v1',
  baseUrlEnv: 'OLLAMA_BASE_URL',
  apiKeyEnv: 'OLLAMA_API_KEY',
  prefix: 'ollama:',
  keyOptional: true,
};

export const GEMINI_CONFIG: OpenAICompatConfig = {
  name: 'gemini',
  label: 'Google Gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  baseUrlEnv: 'GEMINI_BASE_URL',
  apiKeyEnv: 'GEMINI_API_KEY',
  prefix: 'gemini:',
  modelHints: ['gemini-'],
};

export class GroqAdapter extends OpenAICompatAdapter {
  constructor(apiKey?: string) { super(GROQ_CONFIG, apiKey); }
}
export class TogetherAdapter extends OpenAICompatAdapter {
  constructor(apiKey?: string) { super(TOGETHER_CONFIG, apiKey); }
}
export class OllamaAdapter extends OpenAICompatAdapter {
  constructor(apiKey?: string) { super(OLLAMA_CONFIG, apiKey); }
}
export class GeminiAdapter extends OpenAICompatAdapter {
  constructor(apiKey?: string) { super(GEMINI_CONFIG, apiKey); }
}
