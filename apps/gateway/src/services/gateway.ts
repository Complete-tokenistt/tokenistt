import { 
  OpenAIChatCompletionRequest, 
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChoice,
  ProviderType,
  GatewayError
} from '../types/index.js';
import { ProviderRegistry, ProviderConfig } from '../providers/registry.js';
import { BaseProviderAdapter } from '../providers/base.js';
import { calculateCost } from './pricing.js';
import { withRetry } from './retry.js';

const VALID_ROLES = ['system', 'user', 'assistant', 'tool'];

export interface GatewayConfig {
  defaultProvider?: ProviderType;
  enableMetrics?: boolean;
  maxRetries?: number;
  requestTimeout?: number;
}

export class GatewayService {
  private registry: ProviderRegistry;
  private config: Required<GatewayConfig>;
  
  constructor(config?: GatewayConfig, providerConfig?: ProviderConfig) {
    this.registry = new ProviderRegistry(providerConfig);
    this.config = {
      defaultProvider: config?.defaultProvider || 'anthropic',
      enableMetrics: config?.enableMetrics ?? true,
      maxRetries: config?.maxRetries ?? 3,
      requestTimeout: config?.requestTimeout ?? 120000,
    };
    // Only set default provider if it exists
    if (this.registry.hasProvider(this.config.defaultProvider)) {
      this.registry.setDefaultProvider(this.config.defaultProvider);
    }
  }
  
  async handleChatCompletion(
    request: OpenAIChatCompletionRequest,
    providerOverride?: ProviderType,
    apiKeyOverride?: string | null
  ): Promise<OpenAIChatCompletionResponse> {
    const startTime = Date.now();
    
    const providerType = providerOverride || 
                         this.registry.detectProvider(request.model);
    
    let provider = this.registry.getProvider(providerType);
    if (!provider && apiKeyOverride) {
      provider = this.registry.ensureKeyless(providerType);
    }
    
    if (!provider) {
      throw new GatewayError(
        `Provider ${providerType} is not configured`,
        503,
        providerType,
        'PROVIDER_NOT_CONFIGURED'
      );
    }
    
    try {
      const translatedRequest = provider.translateRequest(request);
      const providerResponse = await withRetry(
        () => provider.callProvider(translatedRequest, apiKeyOverride),
        { maxRetries: this.config.maxRetries }
      );
      const latencyMs = Date.now() - startTime;
      
      const actualCost = calculateCost(
        providerType,
        request.model,
        providerResponse.inputTokens,
        providerResponse.outputTokens
      );
      
      const parsedResponse = provider.parseResponse(providerResponse);
      
      const response = this.buildOpenAIResponse(
        request,
        parsedResponse.content,
        parsedResponse.finishReason,
        providerResponse.inputTokens,
        providerResponse.outputTokens,
        {
          provider: providerType,
          actual_cost: actualCost,
          latency_ms: latencyMs,
          model_used: providerResponse.modelId,
        }
      );
      
      return response;
      
    } catch (error: any) {
      if (error instanceof GatewayError) {
        throw error;
      }
      
      throw new GatewayError(
        `Provider ${providerType} error: ${error.message}`,
        error.response?.status || 500,
        providerType,
        'PROVIDER_ERROR'
      );
    }
  }
  
  private buildOpenAIResponse(
    request: OpenAIChatCompletionRequest,
    content: string,
    finishReason: string,
    promptTokens: number,
    completionTokens: number,
    metadata: {
      provider: ProviderType;
      actual_cost: number;
      latency_ms: number;
      model_used: string;
    }
  ): OpenAIChatCompletionResponse {
    const id = `chatcmpl-${this.generateId()}`;
    const created = Math.floor(Date.now() / 1000);
    
    const choice: OpenAIChatCompletionChoice = {
      index: 0,
      message: {
        role: 'assistant',
        content,
      },
      finish_reason: this.mapFinishReason(finishReason),
    };
    
    const response: OpenAIChatCompletionResponse = {
      id,
      object: 'chat.completion',
      created,
      model: request.model,
      choices: [choice],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      provider: metadata.provider,
      actual_cost: metadata.actual_cost,
      latency_ms: metadata.latency_ms,
      model_used: metadata.model_used,
    };
    
    return response;
  }
  
  private mapFinishReason(reason: string): OpenAIChatCompletionChoice['finish_reason'] {
    switch (reason.toLowerCase()) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      case 'tool_calls':
        return 'tool_calls';
      default:
        return 'stop';
    }
  }
  
  private generateId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 24; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
  
  setDefaultProvider(provider: ProviderType): void {
    this.config.defaultProvider = provider;
    this.registry.setDefaultProvider(provider);
  }
  
  updateProviderConfig(config: ProviderConfig): void {
    if (config.anthropic) {
      this.registry.updateAnthropicConfig(config.anthropic.apiKey);
    }
    if (config.bedrock) {
      this.registry.updateBedrockConfig(
        config.bedrock.awsAccessKeyId,
        config.bedrock.awsSecretAccessKey,
        config.bedrock.region
      );
    }
    if (config.azure) {
      this.registry.updateAzureConfig(
        config.azure.endpoint,
        config.azure.apiKey,
        config.azure.deploymentName,
        config.azure.apiVersion
      );
    }
    if (config.openai) {
      this.registry.updateOpenAIConfig(config.openai.apiKey);
    }
  }
  
  getAvailableProviders(): ProviderType[] {
    return this.registry.getAvailableProviders();
  }
  
  hasProvider(provider: ProviderType): boolean {
    return this.registry.hasProvider(provider);
  }

  detectProvider(model: string): ProviderType {
    return this.registry.detectProvider(model);
  }
}

export function validateChatCompletionRequest(
  request: unknown
): request is OpenAIChatCompletionRequest {
  if (!request || typeof request !== 'object') {
    return false;
  }
  
  const req = request as Record<string, unknown>;
  
  if (typeof req.model !== 'string' || !req.model) {
    return false;
  }
  
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return false;
  }
  
  for (const msg of req.messages) {
    if (!msg || typeof msg !== 'object') {
      return false;
    }
    const message = msg as Record<string, unknown>;
    if (typeof message.role !== 'string') {
      return false;
    }
    if (!VALID_ROLES.includes(message.role)) {
      return false;
    }
    if (message.content !== null && typeof message.content !== 'string') {
      return false;
    }
  }
  
  return true;
}

export function extractProviderFromHeaders(headers: Record<string, string | undefined>): ProviderType | undefined {
  const provider = headers['x-provider'] || headers['x-provider-id'];
  
  if (!provider) {
    return undefined;
  }
  
  const normalizedProvider = provider.toLowerCase();
  
  if (['anthropic', 'bedrock', 'azure', 'openai'].includes(normalizedProvider)) {
    return normalizedProvider as ProviderType;
  }
  
  return undefined;
}
