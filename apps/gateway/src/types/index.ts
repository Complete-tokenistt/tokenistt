// OpenAI Chat Completion Types
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: OpenAIFunction;
  }>;
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  project_tag?: string;
  costCenter?: string;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** OpenAI shape: cached prompt tokens (included in prompt_tokens). */
  prompt_tokens_details?: { cached_tokens: number };
  /** OpenAI shape: reasoning tokens (included in completion_tokens). */
  completion_tokens_details?: { reasoning_tokens: number };
  /** Anthropic shape: cache reads/writes are reported separately from input tokens. */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface OpenAIChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChatCompletionChoice[];
  usage: OpenAIUsage;
  provider?: string;
  actual_cost?: number;
  latency_ms?: number;
  model_used?: string;
  _tokenistt?: Record<string, any>;
}

// Provider identifier
export type ProviderType =
  | 'anthropic' | 'bedrock' | 'azure' | 'openai'
  | 'groq' | 'together' | 'ollama' | 'gemini' | 'mock';

// Unified metadata
export interface UnifiedMetadata {
  provider: ProviderType;
  actual_cost: number;
  latency_ms: number;
  model_used: string;
  request_id?: string;
}

export interface PricingTier {
  input: number;  // per 1M tokens
  output: number; // per 1M tokens
  cachedInput?: number; // per 1M cached tokens
  cacheWrite?: number;  // per 1M cache write / creation tokens
  reasoning?: number;   // per 1M reasoning tokens
}

// Request context
export interface RequestContext {
  provider: ProviderType;
  originalRequest: OpenAIChatCompletionRequest;
  startTime: number;
}

// Provider response interface
export interface ProviderResponse {
  content: string;
  stopReason: 'stop' | 'length' | 'content_filter';
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache (OpenAI cached_tokens / Anthropic cache_read_input_tokens). */
  cacheReadTokens?: number;
  /** Tokens written to the provider's prompt cache (Anthropic cache_creation_input_tokens). */
  cacheCreationTokens?: number;
  /** Reasoning tokens (OpenAI completion_tokens_details.reasoning_tokens), already included in outputTokens. */
  reasoningTokens?: number;
  modelId: string;
  rawResponse?: unknown;
}

// Error types
export class GatewayError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public provider?: ProviderType,
    public code?: string
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
