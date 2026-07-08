/**
 * OpenAI-compatible type surface.
 *
 * These are deliberately structured to mirror `openai@4.x` so existing code
 * (including @types/openai consumers) can swap `OpenAI` for `Tokenistt`
 * without type errors. A focused but complete subset of the API is typed
 * here; the underlying client forwards *any* body/query to the gateway, so
 * newer fields not yet present in these types still pass through.
 */

/* ----------------------------------------------------------------------------
 * Shared primitives
 * ------------------------------------------------------------------------- */

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
}

export type Role = 'system' | 'user' | 'assistant' | 'tool' | 'function';

export interface FunctionCall {
  name: string;
  arguments: string;
}

export interface FunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ToolDefinition {
  type: 'function';
  function: FunctionDefinition;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: FunctionCall;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

/* ----------------------------------------------------------------------------
 * Chat messages
 * ------------------------------------------------------------------------- */

export interface ChatCompletionContentPartText {
  type: 'text';
  text: string;
}

export interface ChatCompletionContentPartImage {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export type ChatCompletionContentPart =
  | ChatCompletionContentPartText
  | ChatCompletionContentPartImage;

export interface SystemMessageParam {
  role: 'system';
  content: string;
  name?: string;
}

export interface UserMessageParam {
  role: 'user';
  content: string | ChatCompletionContentPart[];
  name?: string;
}

export interface AssistantMessageParam {
  role: 'assistant';
  content?: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  function_call?: FunctionCall | null;
}

export interface ToolMessageParam {
  role: 'tool';
  content: string;
  tool_call_id: string;
}

export interface FunctionMessageParam {
  role: 'function';
  content: string;
  name: string;
}

export type ChatCompletionMessageParam =
  | SystemMessageParam
  | UserMessageParam
  | AssistantMessageParam
  | ToolMessageParam
  | FunctionMessageParam;

export type ChatCompletionMessageToolCall = ToolCall;
export type ChatCompletionMessageFunctionCall = FunctionCall;

/* ----------------------------------------------------------------------------
 * Chat completions — request
 * ------------------------------------------------------------------------- */

export interface ResponseFormatText {
  type: 'text';
}
export interface ResponseFormatJSONObject {
  type: 'json_object';
}
export interface ResponseFormatJSONSchema {
  type: 'json_schema';
  json_schema: {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}
export type ResponseFormat =
  | ResponseFormatText
  | ResponseFormatJSONObject
  | ResponseFormatJSONSchema;

export interface ChatCompletionCreateParamsBase {
  messages: ChatCompletionMessageParam[];
  model: string;

  frequency_penalty?: number | null;
  logit_bias?: Record<string, number> | null;
  logprobs?: boolean | null;
  top_logprobs?: number | null;
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  n?: number | null;
  presence_penalty?: number | null;
  response_format?: ResponseFormat | null;
  seed?: number | null;
  stop?: string | string[] | null;
  temperature?: number | null;
  tool_choice?:
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } }
    | null;
  tools?: ToolDefinition[] | null;
  parallel_tool_calls?: boolean | null;
  top_p?: number | null;
  user?: string;
  reasoning_effort?: 'low' | 'medium' | 'high' | null;
  store?: boolean | null;
  metadata?: Record<string, string> | null;
  service_tier?: 'auto' | 'default' | string | null;
  modalities?: ('text' | 'audio')[] | null;
  audio?: { voice: string; format: string } | null;
  prediction?: { type: 'content'; content: string | ChatCompletionContentPart[] } | null;
  stream?: boolean | null;
}

export interface ChatCompletionCreateParamsNonStreaming
  extends ChatCompletionCreateParamsBase {
  stream?: false | null;
}

export interface ChatCompletionCreateParamsStreaming
  extends ChatCompletionCreateParamsBase {
  stream: true;
  stream_options?: {
    include_usage?: boolean;
    continuous_usage?: boolean;
  } | null;
}

export type ChatCompletionCreateParams =
  | ChatCompletionCreateParamsNonStreaming
  | ChatCompletionCreateParamsStreaming;

/* ----------------------------------------------------------------------------
 * Chat completions — response
 * ------------------------------------------------------------------------- */

export interface ChatCompletionMessage {
  role: 'assistant';
  content: string | null;
  refusal?: string | null;
  function_call?: FunctionCall | null;
  tool_calls?: ToolCall[] | null;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason:
    | 'stop'
    | 'length'
    | 'tool_calls'
    | 'content_filter'
    | 'function_call'
    | null;
  logprobs?: {
    content: {
      token: string;
      logprob: number;
      bytes: number[];
      top_logprobs: { token: string; logprob: number; bytes: number[] }[];
    }[] | null;
  } | null;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: ChatCompletionChoice[];
  usage: Usage | null;
  service_tier?: string | null;
}

/* Chat completion chunks (streaming) */
export interface ChatCompletionChunkChoiceDelta {
  role?: Role;
  content?: string | null;
  refusal?: string | null;
  function_call?: FunctionCall | null;
  tool_calls?: ToolCallDelta[] | null;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkChoiceDelta;
  finish_reason:
    | 'stop'
    | 'length'
    | 'tool_calls'
    | 'content_filter'
    | 'function_call'
    | null;
  logprobs?: {
    content: {
      token: string;
      logprob: number;
      bytes: number[];
      top_logprobs: { token: string; logprob: number; bytes: number[] }[];
    }[] | null;
  } | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: ChatCompletionChunkChoice[];
  usage?: Usage | null;
  service_tier?: string | null;
}

/* ----------------------------------------------------------------------------
 * Legacy completions
 * ------------------------------------------------------------------------- */

export interface CompletionCreateParamsBase {
  model: string;
  prompt?: string | string[] | number[] | number[][] | null;
  best_of?: number | null;
  echo?: boolean | null;
  frequency_penalty?: number | null;
  logit_bias?: Record<string, number> | null;
  logprobs?: number | null;
  max_tokens?: number | null;
  n?: number | null;
  presence_penalty?: number | null;
  seed?: number | null;
  stop?: string | string[] | null;
  stream?: boolean | null;
  suffix?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  user?: string;
}

export interface CompletionCreateParamsNonStreaming
  extends CompletionCreateParamsBase {
  stream?: false | null;
}
export interface CompletionCreateParamsStreaming
  extends CompletionCreateParamsBase {
  stream: true;
}
export type CompletionCreateParams =
  | CompletionCreateParamsNonStreaming
  | CompletionCreateParamsStreaming;

export interface CompletionChoice {
  text: string;
  index: number;
  finish_reason: 'stop' | 'length' | null;
  logprobs?: {
    tokens: string[];
    token_logprobs: (number | null)[];
    top_logprobs: (Record<string, number> | null)[];
    text_offset: number[];
  } | null;
}
export interface Completion {
  id: string;
  object: 'text_completion';
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage: Usage | null;
  system_fingerprint?: string;
}

/* ----------------------------------------------------------------------------
 * Embeddings
 * ------------------------------------------------------------------------- */

export interface Embedding {
  object: 'embedding';
  index: number;
  embedding: number[] | Float32Array;
}

export interface CreateEmbeddingResponse {
  object: 'list';
  data: Embedding[];
  model: string;
  usage: Usage;
}

export interface EmbeddingCreateParams {
  model: string;
  input: string | string[] | number[] | number[][] | Record<string, unknown>;
  encoding_format?: 'float' | 'base64';
  dimensions?: number | null;
  user?: string;
}

/* ----------------------------------------------------------------------------
 * Moderations
 * ------------------------------------------------------------------------- */

export interface ModerationCreateParams {
  model?: string | null;
  input: string | string[];
}

export interface ModerationCategories {
  hate: boolean;
  'hate/threatening': boolean;
  'self-harm': boolean;
  sexual: boolean;
  'sexual/minors': boolean;
  violence: boolean;
  'violence/graphic': boolean;
}
export interface ModerationCategoryScores extends Record<string, number> {}
export interface ModerationResult {
  id: string;
  model: string;
  flagged: boolean;
  categories: ModerationCategories;
  category_scores: ModerationCategoryScores;
}
export interface CreateModerationResponse {
  id: string;
  model: string;
  results: ModerationResult[];
}

/* ----------------------------------------------------------------------------
 * Models
 * ------------------------------------------------------------------------- */

export interface Model {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  permission?: unknown[];
  root?: string;
  parent?: string | null;
}
export interface ModelListResponse {
  object: 'list';
  data: Model[];
}

/* ----------------------------------------------------------------------------
 * Generic request / response passthrough
 * ------------------------------------------------------------------------- */

export interface TokenisttResponse<T = unknown> {
  object: string;
  data: T;
}
