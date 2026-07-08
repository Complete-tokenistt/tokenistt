import { APIResource } from '../core/resource';
import { Stream } from '../core/stream';
import type {
  Completion,
  CompletionCreateParams,
  CompletionCreateParamsNonStreaming,
  CompletionCreateParamsStreaming,
} from '../types';
import { ResourceOptions } from './chat';

export class Completions extends APIResource {
  /**
   * Legacy `/completions` endpoint (non-chat text completion). Supports
   * streaming via the generic `Stream<Completion>`.
   */
  async create(
    body: CompletionCreateParamsNonStreaming,
    options?: ResourceOptions,
  ): Promise<Completion>;
  async create(
    body: CompletionCreateParamsStreaming,
    options?: ResourceOptions,
  ): Promise<Stream<Completion>>;
  async create(
    body: CompletionCreateParams,
    options?: ResourceOptions,
  ): Promise<Completion | Stream<Completion>> {
    const stream = body.stream === true;

    const res = await this.client.request({
      method: 'POST',
      path: '/completions',
      body,
      stream,
      user: options?.user,
      costCenter: options?.costCenter,
      timeout: options?.timeout,
      maxRetries: options?.maxRetries,
      signal: options?.signal,
    });

    if (stream) {
      return new Stream<Completion>(res, (line) => {
        try {
          return JSON.parse(line) as Completion;
        } catch {
          return null;
        }
      });
    }

    const json = (await res.json()) as Completion;
    if (json.usage) {
      this.client.recordUsage(json.usage, {
        model: body.model,
        user: options?.user ?? this.client.user,
        costCenter: options?.costCenter ?? this.client.costCenter,
        requestId: res.headers.get('x-request-id') ?? undefined,
      });
    }
    return json;
  }
}
