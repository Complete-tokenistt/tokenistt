import { ProviderType } from '../types/index.js';
import { AnthropicAdapter } from './anthropic.js';
import { BedrockAdapter } from './bedrock.js';
import { AzureAdapter } from './azure.js';
import { BaseProviderAdapter } from './base.js';

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
    
    if (normalizedModel.includes('claude')) {
      return 'anthropic';
    }
    
    if (normalizedModel.includes('bedrock') || 
        normalizedModel.includes('llama') || 
        normalizedModel.includes('mistral') ||
        normalizedModel.includes('ai21') ||
        normalizedModel.includes('titan')) {
      return 'bedrock';
    }
    
    if (normalizedModel.includes('azure')) {
      return 'azure';
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
}
