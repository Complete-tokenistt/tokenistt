import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

// ============================================
// Core Types (matching OpenAI API)
// ============================================

export type RoleEnum = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatCompletionMessageParam {
  role: RoleEnum;
  content: string | null;
  name?: string;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
}

export interface ChatCompletionToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionFunctionParameters {
  type: 'object';
  properties?: Record<string, ChatCompletionFunctionParameters | { type: string; enum?: string[]; description?: string }>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ChatCompletionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: ChatCompletionFunctionParameters;
  };
}

export type ChatCompletionToolChoiceOption = 'auto' | 'none' | {
  type: 'function';
  function: { name: string };
};

export interface CompletionCreateParams {
  model: string;
  messages: ChatCompletionMessageParam[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  tools?: ChatCompletionTool[];
  tool_choice?: ChatCompletionToolChoiceOption;
  cost_center?: string;
  cost_estimate?: number;
}

export interface CompletionCreateParamsStreaming extends CompletionCreateParams {
  stream: true;
}

// ============================================
// Response Types
// ============================================

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ChatCompletionToolCall[];
}

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls';

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: FinishReason;
  logprobs?: unknown;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
  provider?: string;
  actual_cost?: number;
  latency_ms?: number;
  model_used?: string;
  _attribution?: {
    userId: string;
    costCenter: string;
    workspace: string;
    cost: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatCompletionMessage>;
    finish_reason?: FinishReason;
  }>;
}

// ============================================
// Configuration Types
// ============================================

export interface TokenistConfig {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  httpAgent?: HttpAgent;
  httpsAgent?: HttpsAgent;
  
  onUsage?: (usage: UsageCallback) => void;
  onCost?: (cost: CostCallback) => void;
  onBudgetWarning?: (warning: BudgetWarning) => void;
  onError?: (error: Error) => void;
  
  defaultUser?: string;
  defaultCostCenter?: string;
}

export interface UsageCallback {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

export interface CostCallback {
  cost: number;
  model: string;
  provider?: string;
  promptTokens: number;
  completionTokens: number;
}

export interface BudgetWarning {
  userId: string;
  costCenter: string;
  budgetUsed: number;
  budgetLimit: number;
  budgetRemaining: number;
  percentageUsed: number;
}

// ============================================
// Error Types
// ============================================

export class APIError extends Error {
  status?: number;
  headers?: Record<string, string>;
  code?: string;
  param?: string;
  type?: string;
  
  constructor(
    message: string,
    status?: number,
    code?: string,
    type?: string,
    param?: string,
    headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.code = code;
    this.type = type;
    this.param = param;
    this.headers = headers;
  }
}

export class RateLimitError extends APIError {
  constructor(message: string, status?: number, headers?: Record<string, string>) {
    super(message, status, 'rate_limit_exceeded', 'rate_limit', undefined, headers);
    this.name = 'RateLimitError';
  }
}

export class AuthenticationError extends APIError {
  constructor(message: string, headers?: Record<string, string>) {
    super(message, 401, 'authentication_error', 'auth', undefined, headers);
    this.name = 'AuthenticationError';
  }
}

export class BudgetExceededError extends APIError {
  limit: number;
  used: number;
  estimatedCost: number;
  
  constructor(limit: number, used: number, estimatedCost: number, message?: string) {
    super(message || 'Budget exceeded', 429, 'budget_exceeded', 'budget', undefined, undefined);
    this.name = 'BudgetExceededError';
    this.limit = limit;
    this.used = used;
    this.estimatedCost = estimatedCost;
  }
}

export class NotFoundError extends APIError {
  constructor(message: string, headers?: Record<string, string>) {
    super(message, 404, 'not_found', 'not_found', undefined, headers);
    this.name = 'NotFoundError';
  }
}
