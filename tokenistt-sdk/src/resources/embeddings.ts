import { APIResource } from '../core/resource';
import type {
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
} from '../types';
import { ResourceOptions } from './chat';

export class Embeddings extends APIResource {
  async create(
    body: EmbeddingCreateParams,
    options?: ResourceOptions,
  ): Promise<CreateEmbeddingResponse> {
    const res = await this.client.request({
      method: 'POST',
      path: '/embeddings',
      body,
      user: options?.user,
      costCenter: options?.costCenter,
      timeout: options?.timeout,
      maxRetries: options?.maxRetries,
      signal: options?.signal,
    });

    const requestId = res.headers.get('x-request-id') ?? undefined;
    const json = (await res.json()) as CreateEmbeddingResponse;

    if (json.usage) {
      this.client.recordUsage(json.usage, {
        model: body.model,
        user: options?.user ?? this.client.user,
        costCenter: options?.costCenter ?? this.client.costCenter,
        requestId,
      });
    }
    return json;
  }
}
