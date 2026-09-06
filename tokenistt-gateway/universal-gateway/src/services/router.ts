import { 
  OpenAIChatCompletionRequest, 
  OpenAIChatCompletionResponse,
  ProviderType,
  GatewayError
} from '../types/index.js';
import { GatewayService } from './gateway.js';
import { AuthContext } from '../db/auth.js';

export interface RouterConfig {
  enableFailover?: boolean;
  fallbackChain?: Record<ProviderType, ProviderType[]>;
}

export class SmartRouter {
  private gateway: GatewayService;
  private enableFailover: boolean;
  private fallbackChain: Record<ProviderType, ProviderType[]>;

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
      try {
        if (i > 0) {
          console.warn(`[SmartRouter 🔄] Primary provider '${primaryProvider}' failed. Failing over to '${currentProvider}' (attempt ${i + 1}/${candidates.length})`);
        }

        const response = await this.gateway.handleChatCompletion(request, currentProvider, apiKeyOverride);
        
        if (i > 0) {
          response._tokenistt = {
            ...response._tokenistt,
            failover_used: true,
            original_provider: primaryProvider,
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

    throw lastError || new GatewayError(
      `All attempted providers failed for model ${request.model}`,
      503,
      primaryProvider,
      'ALL_PROVIDERS_FAILED'
    );
  }
}
