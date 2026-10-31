import { 
  OpenAIChatCompletionRequest, 
  OpenAIChatCompletionResponse,
  ProviderType,
  GatewayError
} from '../types/index.js';
import { GatewayService } from './gateway.js';
import { AuthContext } from '../db/auth.js';
import { isKeyFailure, markKeyResult, type KeyCandidate } from './byok.js';
import type { RouteTarget } from './routingEngine.js';
import { providerBreaker } from './circuitBreaker.js';

export interface RouterConfig {
  enableFailover?: boolean;
  fallbackChain?: Partial<Record<ProviderType, ProviderType[]>>;
}

// Model mapping for cross-provider failover so fallbacks don't fail with 400 Bad Request
const CROSS_PROVIDER_MODEL_MAP: Partial<Record<ProviderType, Record<string, string>>> = {
  openai: {
    'claude-3-opus': 'gpt-4',
    'claude-3-opus-20240229': 'gpt-4',
    'claude-3-sonnet': 'gpt-4-turbo',
    'claude-3-sonnet-20240229': 'gpt-4-turbo',
    'claude-3-5-sonnet': 'gpt-4o',
    'claude-3-5-sonnet-20241022': 'gpt-4o',
    'claude-3-haiku': 'gpt-3.5-turbo',
    'claude-3-haiku-20240307': 'gpt-3.5-turbo',
    'claude-3-5-haiku': 'gpt-4o-mini',
    'claude-3-5-haiku-20241022': 'gpt-4o-mini',
  },
  anthropic: {
    'gpt-4': 'claude-3-opus-20240229',
    'gpt-4-turbo': 'claude-3-5-sonnet-20241022',
    'gpt-4o': 'claude-3-5-sonnet-20241022',
    'gpt-4o-mini': 'claude-3-5-haiku-20241022',
    'gpt-3.5-turbo': 'claude-3-haiku-20240307',
  },
  azure: {
    'gpt-4': 'gpt-4',
    'gpt-4-turbo': 'gpt-4-turbo',
    'gpt-4o': 'gpt-4o',
    'gpt-3.5-turbo': 'gpt-35-turbo',
    'claude-3-5-sonnet': 'gpt-4o',
    'claude-3-opus': 'gpt-4',
  },
  bedrock: {
    'claude-3-opus': 'claude-3-opus',
    'claude-3-sonnet': 'claude-3-sonnet',
    'claude-3-haiku': 'claude-3-haiku',
    'gpt-4': 'claude-3-opus',
    'gpt-4o': 'claude-3-sonnet',
    'gpt-3.5-turbo': 'claude-3-haiku',
  },
};

export class SmartRouter {
  private gateway: GatewayService;
  private enableFailover: boolean;
  private fallbackChain: Partial<Record<ProviderType, ProviderType[]>>;

  constructor(gateway: GatewayService, config?: RouterConfig) {
    this.gateway = gateway;
    this.enableFailover = config?.enableFailover ?? (process.env.ENABLE_FAILOVER !== 'false');

    // Default fallback chains per provider
    this.fallbackChain = config?.fallbackChain || {
      anthropic: (process.env.FALLBACK_CHAIN_ANTHROPIC?.split(',') as ProviderType[]) || ['openai', 'bedrock'],
      openai:    (process.env.FALLBACK_CHAIN_OPENAI?.split(',') as ProviderType[])    || ['anthropic', 'azure'],
      azure:     (process.env.FALLBACK_CHAIN_AZURE?.split(',') as ProviderType[])     || ['openai', 'anthropic'],
      bedrock:   (process.env.FALLBACK_CHAIN_BEDROCK?.split(',') as ProviderType[])   || ['anthropic', 'openai'],
    };
  }

  /**
   * Translates model for a target failover provider if needed.
   */
  private resolveFailoverModel(targetProvider: ProviderType, originalModel: string): string | null {
    const directNormalized = originalModel.toLowerCase();
    
    // If the target provider map explicitly translates this model
    const mapped = CROSS_PROVIDER_MODEL_MAP[targetProvider]?.[directNormalized] ||
                   CROSS_PROVIDER_MODEL_MAP[targetProvider]?.[originalModel];
    if (mapped) return mapped;

    // Check if target provider might natively support this model ID
    if (targetProvider === 'openai' && (directNormalized.startsWith('gpt-') || directNormalized.startsWith('o1') || directNormalized.startsWith('o3'))) {
      return originalModel;
    }
    if (targetProvider === 'anthropic' && directNormalized.startsWith('claude')) {
      return originalModel;
    }
    if (targetProvider === 'azure' && (directNormalized.startsWith('gpt-') || directNormalized.startsWith('o1'))) {
      return originalModel;
    }
    if (targetProvider === 'bedrock' && (directNormalized.includes('claude') || directNormalized.includes('llama') || directNormalized.includes('mistral'))) {
      return originalModel;
    }

    return null;
  }

  /**
   * Execute chat completion with intelligent failover across providers if enabled.
   */
  async handleChatCompletion(
    request: OpenAIChatCompletionRequest,
    providerOverride?: ProviderType,
    apiKeyOverride?: string | null
  ): Promise<OpenAIChatCompletionResponse> {
    const primaryProvider = providerOverride || this.gateway.detectProvider(request.model);
    
    if (!this.enableFailover) {
      return this.gateway.handleChatCompletion(request, primaryProvider, apiKeyOverride);
    }

    const availableProviders = this.gateway.getAvailableProviders();
    const fallbacks = (this.fallbackChain[primaryProvider] || [])
      .filter(p => availableProviders.includes(p) && p !== primaryProvider);

    const candidates: ProviderType[] = [primaryProvider, ...fallbacks];
    let lastError: Error | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const currentProvider = candidates[i];
      let targetRequest = request;

      try {
        if (i > 0) {
          const failoverModel = this.resolveFailoverModel(currentProvider, request.model);
          if (!failoverModel) {
            console.warn(`[SmartRouter 🔄] No model translation found for ${request.model} -> ${currentProvider}. Skipping fallback.`);
            continue;
          }

          if (failoverModel !== request.model) {
            targetRequest = { ...request, model: failoverModel };
          }

          console.warn(`[SmartRouter 🔄] Primary provider '${primaryProvider}' failed. Failing over to '${currentProvider}' with model '${targetRequest.model}' (attempt ${i + 1}/${candidates.length})`);
        }

        const response = await this.gateway.handleChatCompletion(targetRequest, currentProvider, apiKeyOverride);
        
        if (i > 0) {
          response._tokenistt = {
            ...response._tokenistt,
            failover_used: true,
            original_provider: primaryProvider,
            original_model: request.model,
            fallback_model: targetRequest.model,
          } as any;
        }

        return response;
      } catch (err: any) {
        lastError = err;
        
        // Don't failover for client validation or auth errors
        if (err instanceof GatewayError && (err.statusCode === 400 || err.statusCode === 401 || err.statusCode === 403)) {
          throw err;
        }

        console.error(`[SmartRouter ❌] Provider '${currentProvider}' attempt failed: ${err.message}`);
      }
    }

    throw new GatewayError(
      `All attempted providers failed for model ${request.model}: ${lastError?.message || 'Unknown error'}`,
      503,
      primaryProvider,
      'ALL_PROVIDERS_FAILED'
    );
  }

  /** Default candidate list: primary provider + configured failover chain with model translation. */
  private defaultCandidates(request: OpenAIChatCompletionRequest, primary: ProviderType): RouteTarget[] {
    const out: RouteTarget[] = [{ provider: primary, model: request.model }];
    if (!this.enableFailover) return out;
    const available = this.gateway.getAvailableProviders();
    for (const p of this.fallbackChain[primary] || []) {
      if (p === primary || !available.includes(p)) continue;
      const model = this.resolveFailoverModel(p, request.model);
      if (model) out.push({ provider: p, model });
    }
    return out;
  }

  /**
   * Full routing path: explicit candidates (from a routing rule) or the default
   * failover chain, each tried with every BYOK key in priority order.
   * A bad/limited key moves to the next key; other provider errors move to the
   * next provider; client errors (400/401/403 GatewayError) surface immediately.
   */
  async route(
    request: OpenAIChatCompletionRequest,
    opts: {
      providerOverride?: ProviderType;
      candidates?: RouteTarget[];
      keys: (provider: string) => Promise<KeyCandidate[]>;
    }
  ): Promise<OpenAIChatCompletionResponse> {
    const primary = opts.providerOverride || this.gateway.detectProvider(request.model);
    const candidates = opts.candidates?.length ? opts.candidates : this.defaultCandidates(request, primary);
    let lastError: Error | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const target = candidates[i];
      const isLast = i === candidates.length - 1;
      if (!providerBreaker.allow(target.provider) && !isLast) {
        console.warn(`[SmartRouter ⛔] circuit open for '${target.provider}', skipping`);
        lastError = new Error(`circuit open for ${target.provider}`);
        continue;
      }
      const targetRequest = target.model === request.model ? request : { ...request, model: target.model };
      const keys = await opts.keys(target.provider);

      for (const k of keys) {
        try {
          const response = await this.gateway.handleChatCompletion(targetRequest, target.provider as ProviderType, k.key);
          markKeyResult(k.id, true).catch(() => {});
          providerBreaker.success(target.provider);
          if (i > 0 || (opts.candidates?.length ?? 0) > 0) {
            response._tokenistt = {
              ...response._tokenistt,
              routed_provider: target.provider,
              routed_model: target.model,
              ...(i > 0 ? { failover_used: true, original_model: request.model } : {}),
              ...(k.id ? { key_label: k.label } : {}),
            } as any;
          }
          return response;
        } catch (err: any) {
          lastError = err;
          if (err instanceof GatewayError && [400, 401, 403].includes(err.statusCode)) throw err;
          providerBreaker.failure(target.provider);
          if (isKeyFailure(err) && k.id) {
            markKeyResult(k.id, false, err.message).catch(() => {});
            console.warn(`[SmartRouter 🔑] key '${k.label}' failed for ${target.provider}: ${err.message}; trying next key`);
            continue;
          }
          console.error(`[SmartRouter ❌] ${target.provider} failed: ${err.message}`);
          break; // not a key problem — move on to the next provider
        }
      }
    }

    throw new GatewayError(
      `All attempted providers failed for model ${request.model}: ${lastError?.message || 'Unknown error'}`,
      503,
      primary,
      'ALL_PROVIDERS_FAILED'
    );
  }
}
