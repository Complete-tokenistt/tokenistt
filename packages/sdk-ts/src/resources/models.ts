import { APIResource } from '../core/resource';
import type { Model, ModelListResponse } from '../types';
import { ResourceOptions } from './chat';

export class Models extends APIResource {
  /** GET /models — list available models. */
  async list(options?: ResourceOptions): Promise<ModelListResponse> {
    const res = await this.client.request({
      method: 'GET',
      path: '/models',
      user: options?.user,
      costCenter: options?.costCenter,
      timeout: options?.timeout,
      maxRetries: options?.maxRetries,
      signal: options?.signal,
    });
    return (await res.json()) as ModelListResponse;
  }

  /** GET /models/{model} — retrieve a single model. */
  async retrieve(model: string, options?: ResourceOptions): Promise<Model> {
    const res = await this.client.request({
      method: 'GET',
      path: `/models/${model}`,
      user: options?.user,
      costCenter: options?.costCenter,
      timeout: options?.timeout,
      maxRetries: options?.maxRetries,
      signal: options?.signal,
    });
    return (await res.json()) as Model;
  }

  /** DELETE /models/{model} — delete a fine-tuned model. */
  async del(model: string, options?: ResourceOptions): Promise<{ id: string; object: 'model'; deleted: boolean }> {
    const res = await this.client.request({
      method: 'DELETE',
      path: `/models/${model}`,
      user: options?.user,
      costCenter: options?.costCenter,
      timeout: options?.timeout,
      maxRetries: options?.maxRetries,
      signal: options?.signal,
    });
    return (await res.json()) as { id: string; object: 'model'; deleted: boolean };
  }
}
