import { ProviderType } from '../types/index.js';
import { AnthropicAdapter } from './anthropic.js';
import { BedrockAdapter } from './bedrock.js';
import { AzureAdapter } from './azure.js';
import { OpenAIAdapter } from './openai.js';
import { BaseProviderAdapter } from './base.js';
import {
  OpenAICompatAdapter,
  GroqAdapter,
  TogetherAdapter,
  OllamaAdapter,
  GeminiAdapter,
  GROQ_CONFIG,
  TOGETHER_CONFIG,
  OLLAMA_CONFIG,
  GEMINI_CONFIG,
} from './openaiCompat.js';

/** OpenAI-compatible providers: registered from env, routed by model prefix/hints. */
const COMPAT_PROVIDERS = [
  { cfg: GROQ_CONFIG, make: (k?: string) => new GroqAdapter(k) },
  { cfg: TOGETHER_CONFIG, make: (k?: string) => new TogetherAdapter(k) },
  { cfg: OLLAMA_CONFIG, make: (k?: string) => new OllamaAdapter(k) },
  { cfg: GEMINI_CONFIG, make: (k?: string) => new GeminiAdapter(k) },
] as const;

export interface ProviderConfig {
  anthropic?: {
    apiKey: string;
  };
  bedrock?: {
    awsAccessKeyId: string;
    awsSecretAccessKey: string;
    region?: string;
  };
  azure?: {
    endpoint: string;
    apiKey: string;
    deploymentName: string;
    apiVersion?: string;
  };
  openai?: {
    apiKey: string;
  };
}

export class ProviderRegistry {
  private providers: Map<ProviderType, BaseProviderAdapter> = new Map();
  private defaultProvider: ProviderType = 'anthropic';
  
  constructor(config?: ProviderConfig) {
    this.initializeProviders(config);
  }
  
  private initializeProviders(config?: ProviderConfig): void {
    if (config?.anthropic) {
      const anthropic = new AnthropicAdapter(config.anthropic.apiKey);
      this.providers.set('anthropic', anthropic);
    } else if (process.env.ANTHROPIC_API_KEY) {
      const anthropic = new AnthropicAdapter(process.env.ANTHROPIC_API_KEY);
      this.providers.set('anthropic', anthropic);
    }
    
    if (config?.bedrock) {
      const bedrock = new BedrockAdapter(
        config.bedrock.awsAccessKeyId,
        config.bedrock.awsSecretAccessKey,
        config.bedrock.region
      );
      this.providers.set('bedrock', bedrock);
    } else if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      const bedrock = new BedrockAdapter(
        process.env.AWS_ACCESS_KEY_ID,
        process.env.AWS_SECRET_ACCESS_KEY,
        process.env.AWS_REGION
      );
      this.providers.set('bedrock', bedrock);
    }
    
    if (config?.azure) {
      const azure = new AzureAdapter(
        config.azure.endpoint,
        config.azure.apiKey,
        config.azure.deploymentName,
        config.azure.apiVersion
      );
      this.providers.set('azure', azure);
    } else if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY) {
      const azure = new AzureAdapter(
        process.env.AZURE_OPENAI_ENDPOINT,
        process.env.AZURE_OPENAI_API_KEY,
        process.env.AZURE_DEPLOYMENT_NAME
      );
      this.providers.set('azure', azure);
    }
    
    if (config?.openai) {
      const openai = new OpenAIAdapter(config.openai.apiKey);
      this.providers.set('openai', openai);
    } else if (process.env.OPENAI_API_KEY) {
      const openai = new OpenAIAdapter(process.env.OPENAI_API_KEY);
      this.providers.set('openai', openai);
    }

    for (const { cfg, make } of COMPAT_PROVIDERS) {
      const key = process.env[cfg.apiKeyEnv];
      // Ollama needs no key: enable it when a base URL is set explicitly.
      if (key || (cfg.keyOptional && process.env[cfg.baseUrlEnv])) {
        this.providers.set(cfg.name, make(key));
      }
    }
  }

  /** Register or update any OpenAI-compatible provider at runtime (BYOK connect). */
  updateCompatConfig(type: ProviderType, apiKey: string): void {
    const entry = COMPAT_PROVIDERS.find(p => p.cfg.name === type);
    if (!entry) throw new Error(`Provider ${type} is not OpenAI-compatible`);
    const existing = this.providers.get(type);
    if (existing instanceof OpenAICompatAdapter) existing.setApiKey(apiKey);
    else this.providers.set(type, entry.make(apiKey));
  }
  
  setDefaultProvider(provider: ProviderType): void {
    if (!this.providers.has(provider)) {
      throw new Error(`Provider ${provider} not configured`);
    }
    this.defaultProvider = provider;
  }
  
  getProvider(type: ProviderType): BaseProviderAdapter | null {
    return this.providers.get(type) || null;
  }
  
  getDefaultProvider(): BaseProviderAdapter | null {
    return this.providers.get(this.defaultProvider) || null;
  }
  
  hasProvider(type: ProviderType): boolean {
    return this.providers.has(type);
  }
  
  getAvailableProviders(): ProviderType[] {
    return Array.from(this.providers.keys());
  }
  
  detectProvider(model: string): ProviderType {
    const normalizedModel = model.toLowerCase();

    for (const { cfg, make } of COMPAT_PROVIDERS) {
      if (make().canHandle(normalizedModel)) return cfg.name;
    }
    
    if (normalizedModel.startsWith('openai:')) {
      return 'openai';
    }
    
    if (normalizedModel.includes('claude')) {
      if (this.hasProvider('anthropic')) return 'anthropic';
      if (this.hasProvider('bedrock')) return 'bedrock';
      return 'anthropic';
    }
    
    if (normalizedModel.includes('bedrock') || 
        normalizedModel.includes('ai21') ||
        normalizedModel.includes('titan')) {
      return this.hasProvider('bedrock') ? 'bedrock' : this.defaultProvider;
    }

    if (normalizedModel.includes('llama') || normalizedModel.includes('mistral')) {
      if (this.hasProvider('bedrock')) return 'bedrock';
      if (this.hasProvider('openai')) return 'openai';
      return this.defaultProvider;
    }

    
    if (normalizedModel.includes('azure')) {
      return 'azure';
    }

    if (
      normalizedModel.includes('openai') ||
      normalizedModel.includes('gpt-') ||
      normalizedModel.startsWith('o1') ||
      normalizedModel.startsWith('o3')
    ) {
      return 'openai';
    }
    
    return this.defaultProvider;
  }
  
  updateAnthropicConfig(apiKey: string): void {
    const adapter = this.providers.get('anthropic') as AnthropicAdapter | undefined;
    if (adapter) {
      adapter.setApiKey(apiKey);
    } else {
      this.providers.set('anthropic', new AnthropicAdapter(apiKey));
    }
  }
  
  updateBedrockConfig(
    awsAccessKeyId: string,
    awsSecretAccessKey: string,
    region?: string
  ): void {
    const adapter = this.providers.get('bedrock') as BedrockAdapter | undefined;
    if (adapter) {
      adapter.setCredentials(awsAccessKeyId, awsSecretAccessKey, region);
    } else {
      this.providers.set('bedrock', new BedrockAdapter(awsAccessKeyId, awsSecretAccessKey, region));
    }
  }
  
  updateAzureConfig(
    endpoint: string,
    apiKey: string,
    deploymentName: string,
    apiVersion?: string
  ): void {
    const adapter = this.providers.get('azure') as AzureAdapter | undefined;
    if (adapter) {
      adapter.configure(endpoint, apiKey, deploymentName, apiVersion);
    } else {
      this.providers.set('azure', new AzureAdapter(endpoint, apiKey, deploymentName, apiVersion));
    }
  }

  updateOpenAIConfig(apiKey: string): void {
    const adapter = this.providers.get('openai') as OpenAIAdapter | undefined;
    if (adapter) {
      adapter.setApiKey(apiKey);
    } else {
      this.providers.set('openai', new OpenAIAdapter(apiKey));
    }
  }
}
