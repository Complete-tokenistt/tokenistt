import axios, { AxiosInstance } from 'axios';
import { 
  OpenAIChatCompletionRequest, 
  ProviderResponse,
  OpenAIMessage 
} from '../types/index.js';
import { BaseProviderAdapter, estimateRequestTokens } from './base.js';

export class AzureAdapter extends BaseProviderAdapter {
  name = 'azure';
  private client: AxiosInstance | null = null;
  private deploymentName: string = '';
  private apiVersion: string = '2024-02-01';
  
  constructor(
    azureEndpoint?: string,
    azureApiKey?: string,
    deploymentName?: string,
    apiVersion?: string
  ) {
    super();
    if (azureEndpoint && azureApiKey) {
      this.configure(azureEndpoint, azureApiKey, deploymentName, apiVersion);
    }
  }
  
  configure(
    azureEndpoint: string,
    azureApiKey: string,
    deploymentName?: string,
    apiVersion?: string
  ): void {
    // Ensure endpoint doesn't have trailing slash
    const baseURL = azureEndpoint.replace(/\/$/, '');
    
    this.client = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
        'api-key': azureApiKey,
      },
    });
    
    if (deploymentName) {
      this.deploymentName = deploymentName;
    }
    
    if (apiVersion) {
      this.apiVersion = apiVersion;
    }
  }
  
  canHandle(model: string): boolean {
    const normalizedModel = model.toLowerCase();
    return (
      normalizedModel.includes('azure') ||
      normalizedModel.includes('gpt-4') ||
      normalizedModel.includes('gpt-35') ||
      normalizedModel.includes('gpt-3.5')
    );
  }
  
  translateRequest(request: OpenAIChatCompletionRequest): {
    messages: Array<{
      role: string;
      content: string | null;
      name?: string;
      tool_calls?: unknown[];
    }>;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    tools?: unknown[];
    tool_choice?: unknown;
    stream?: boolean;
    stop?: string | string[];
    presence_penalty?: number;
    frequency_penalty?: number;
  } {
    // Azure OpenAI uses the same format as OpenAI with some minor differences
    const translatedMessages = request.messages.map(msg => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : null,
      name: msg.name,
      tool_calls: msg.tool_calls?.map(tc => ({
        id: tc.id,
        type: tc.type,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    }));
    
    return {
      messages: translatedMessages,
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens,
      tools: request.tools?.map(tool => ({
        type: tool.type,
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        },
      })),
      tool_choice: request.tool_choice,
      stream: request.stream,
      stop: request.stop,
      presence_penalty: request.presence_penalty,
      frequency_penalty: request.frequency_penalty,
    };
  }
  
  async callProvider(translateRequest: unknown): Promise<ProviderResponse> {
    if (!this.client) {
      throw new Error('Azure OpenAI credentials not configured');
    }
    
    const url = `/openai/deployments/${this.deploymentName}/chat/completions?api-version=${this.apiVersion}`;
    
    try {
      const response = await this.client.post(url, translateRequest);
      const data = response.data;
      
      const choice = data.choices?.[0];
      
      return {
        content: choice?.message?.content || '',
        stopReason: choice?.finish_reason === 'stop' ? 'stop' :
                    choice?.finish_reason === 'length' ? 'length' :
                    choice?.finish_reason === 'content_filter' ? 'content_filter' :
                    choice?.finish_reason === 'tool_calls' ? 'stop' : 'stop',
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        modelId: data.model || this.deploymentName,
        rawResponse: data,
      };
    } catch (error: any) {
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.error?.message || error.response.data?.message || 'Unknown error';
        
        if (status === 401) {
          throw new Error(`Azure OpenAI authentication failed: ${message}`);
        } else if (status === 404) {
          throw new Error(`Azure OpenAI deployment not found: ${this.deploymentName}`);
        } else if (status === 429) {
          throw new Error(`Azure OpenAI rate limit exceeded: ${message}`);
        }
        
        throw new Error(`Azure OpenAI error (${status}): ${message}`);
      }
      throw error;
    }
  }
  
  parseResponse(response: ProviderResponse) {
    return {
      content: response.content,
      finishReason: response.stopReason,
    };
  }
  
  estimateTokens(messages: OpenAIMessage[], model: string): { inputTokens: number } {
    return {
      inputTokens: estimateRequestTokens(messages),
    };
  }
  
  // Set deployment name dynamically
  setDeployment(deploymentName: string): void {
    this.deploymentName = deploymentName;
  }
}
