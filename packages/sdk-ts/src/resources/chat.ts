import { APIResource } from '../core/resource';
import type { Tokenistt } from '../client';
import type {
  ChatCompletion,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from '../types';
import { ChatCompletionStream, CostMeta } from './chatStream';

export interface ResourceOptions {
  user?: string;
  costCenter?: string;
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

export class Completions extends APIResource {
  /**
   * Same signature as `openai`'s `chat.completions.create()`.
   * Returns a `ChatCompletion` (non-stream) or a `ChatCompletionStream`
   * (stream). The latter auto-tracks cost and supports `finalChatCompletion()`.
   */
  async create(
    body: ChatCompletionCreateParamsNonStreaming,
    options?: ResourceOptions,
  ): Promise<ChatCompletion>;
  async create(
    body: ChatCompletionCreateParamsStreaming,
    options?: ResourceOptions,
  ): Promise<ChatCompletionStream>;
  async create(
    body: ChatCompletionCreateParams,
    options?: ResourceOptions,
  ): Promise<ChatCompletion | ChatCompletionStream>;
  async create(
    body: ChatCompletionCreateParams,
    options?: ResourceOptions,
  ): Promise<ChatCompletion | ChatCompletionStream> {
    const stream = body.stream === true;
    const params: Record<string, unknown> = { ...body };

    if (stream) {
      params.stream_options = {
        ...(params.stream_options as object | undefined),
        include_usage: true,
      };
    }

    const res = await this.client.request({
      method: 'POST',
      path: '/chat/completions',
      body: params,
      stream,
      user: options?.user,
      costCenter: options?.costCenter,
      timeout: options?.timeout,
      maxRetries: options?.maxRetries,
      signal: options?.signal,
    });

    const requestId = res.headers.get('x-request-id') ?? undefined;

    if (stream) {
      const meta: CostMeta = {
        model: body.model,
        user: options?.user ?? this.client.user,
        costCenter: options?.costCenter ?? this.client.costCenter,
        requestId,
      };
      return new ChatCompletionStream(res, this.client, meta);
    }

    const json = (await res.json()) as ChatCompletion;
    this.client.recordUsage(json.usage ?? undefined, {
      model: body.model,
      user: options?.user ?? this.client.user,
      costCenter: options?.costCenter ?? this.client.costCenter,
      requestId,
      gatewayCostUsd: gatewayCost(res),
    });
    return json;
  }
}

export class Chat extends APIResource {
  completions: Completions;

  constructor(client: Tokenistt) {
    super(client);
    this.completions = new Completions(client);
  }
}

/** Cost the gateway priced this response at (`x-tokenistt-cost`); undefined when absent or not a plain number. */
function gatewayCost(res: Response): number | undefined {
  const raw = res.headers.get('x-tokenistt-cost');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
