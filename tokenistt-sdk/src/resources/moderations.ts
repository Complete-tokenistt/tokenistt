import { APIResource } from '../core/resource';
import type { CreateModerationResponse, ModerationCreateParams } from '../types';
import { ResourceOptions } from './chat';

export class Moderations extends APIResource {
  async create(
    body: ModerationCreateParams,
    options?: ResourceOptions,
  ): Promise<CreateModerationResponse> {
    const res = await this.client.request({
      method: 'POST',
      path: '/moderations',
      body,
      user: options?.user,
      costCenter: options?.costCenter,
      timeout: options?.timeout,
      maxRetries: options?.maxRetries,
      signal: options?.signal,
    });
    return (await res.json()) as CreateModerationResponse;
  }
}
