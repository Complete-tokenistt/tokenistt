/**
 * services/responseCache.ts — opt-in response cache for identical requests (Redis).
 *
 * A hit skips the provider entirely (zero cost). The key covers org, model and every
 * parameter that affects output, so tenants never share entries. Streaming and
 * tool-calling requests are never cached; non-deterministic requests (temperature > 0)
 * are cached only when the caller asks for mode `always`. Fail-open: any Redis
 * problem is a miss.
 */
import { createHash } from 'node:crypto';
import { getRedisClient } from './redis.js';
import type { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse } from '../types/index.js';

const TTL_SECONDS = parseInt(process.env.RESPONSE_CACHE_TTL || '3600', 10);

export function isCacheable(req: OpenAIChatCompletionRequest, mode: string | undefined): boolean {
  if (!mode || mode === 'false' || mode === '0') return false;
  if (req.stream || (req.tools && req.tools.length > 0)) return false;
  if (mode === 'always') return true;
  return req.temperature === undefined || req.temperature === 0;
}

export function cacheKey(orgId: bigint | string, req: OpenAIChatCompletionRequest): string {
  const material = JSON.stringify([
    orgId.toString(),
    req.model,
    req.messages.map(m => [m.role, m.content, m.name]),
    req.temperature ?? null,
    req.top_p ?? null,
    req.max_tokens ?? null,
    req.stop ?? null,
    req.presence_penalty ?? null,
    req.frequency_penalty ?? null,
  ]);
  return `gateway:rcache:${createHash('sha256').update(material).digest('hex')}`;
}

export async function getCached(key: string): Promise<OpenAIChatCompletionResponse | null> {
  try {
    const raw = await getRedisClient()?.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function putCached(key: string, response: OpenAIChatCompletionResponse): Promise<void> {
  try {
    const { _tokenistt, ...rest } = response as any;
    await getRedisClient()?.set(key, JSON.stringify(rest), 'EX', TTL_SECONDS);
  } catch {
    /* best effort */
  }
}
