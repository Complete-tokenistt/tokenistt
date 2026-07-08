import { 
  BedrockRuntimeClient, 
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand 
} from '@aws-sdk/client-bedrock-runtime';
import { 
  OpenAIChatCompletionRequest, 
  ProviderResponse,
  OpenAIMessage 
} from '../types/index.js';
import { BaseProviderAdapter, estimateRequestTokens } from './base.js';

// Map OpenAI models to Bedrock model IDs
const MODEL_MAP: Record<string, string> = {
  'claude-3-sonnet': 'anthropic.claude-3-sonnet-20240229-v1:0',
  'claude-3-haiku': 'anthropic.claude-3-haiku-20240307-v1:0',
  'claude-3-opus': 'anthropic.claude-3-opus-20240229-v1:0',
  'claude-2.1': 'anthropic.claude-v2:1',
  'claude-2': 'anthropic.claude-v2',
  'claude-instant': 'anthropic.claude-instant-v1',
  'ai21-j2-mid': 'ai21.j2-mid-v1',
  'ai21-j2-ultra': 'ai21.j2-ultra-v1',
  'llama-3-70b': 'meta.llama3-70b-instruct-v1:0',
  'llama-3-8b': 'meta.llama3-8b-instruct-v1:0',
  'mistral-7b': 'mistral.mistral-7b-instruct-v0:2',
  'mistral-large': 'mistral.mistral-large-2402-v1:0',
};

export class BedrockAdapter extends BaseProviderAdapter {
  name = 'bedrock';
  private client: BedrockRuntimeClient | null = null;
  private region: string = 'us-east-1';
  
  constructor(awsAccessKeyId?: string, awsSecretAccessKey?: string, region?: string) {
    super();
    if (awsAccessKeyId && awsSecretAccessKey) {
      this.client = new BedrockRuntimeClient({
        region: region || 'us-east-1',
        credentials: {
          accessKeyId: awsAccessKeyId,
          secretAccessKey: awsSecretAccessKey,
        },
      });
      this.region = region || 'us-east-1';
    }
  }
  
  setCredentials(awsAccessKeyId: string, awsSecretAccessKey: string, region?: string): void {
    this.client = new BedrockRuntimeClient({
      region: region || this.region,
      credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey,
      },
    });
    if (region) {
      this.region = region;
    }
  }
  
  canHandle(model: string): boolean {
    const normalizedModel = model.toLowerCase();
    return (
      normalizedModel.includes('bedrock') ||
      normalizedModel.includes('claude') ||
      normalizedModel.includes('llama') ||
      normalizedModel.includes('mistral') ||
      normalizedModel.includes('ai21') ||
      Object.values(MODEL_MAP).some(id => normalizedModel.includes(id.split('.')[1]?.split('-')[0] || ''))
    );
  }
  
  translateRequest(request: OpenAIChatCompletionRequest): {
    anthropic: {
      system?: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
      temperature?: number;
      stop_sequences?: string[];
    };
    ai21: {
      messages: Array<{ role: string; content: string }>;
      maxTokens?: number;
      temperature?: number;
      stopSequences?: string[];
    };
    llama: {
      messages: Array<{ role: string; content: string }>;
      max_gen_len?: number;
      temperature?: number;
    };
    mistral: {
      messages: Array<{ role: string; content: string }>;
      max_tokens?: number;
      temperature?: number;
    };
    modelId: string;
  } {
    // Determine which model family to use
    const modelKey = this.determineModelKey(request.model);
    const modelId = MODEL_MAP[modelKey] || MODEL_MAP['claude-3-sonnet'];
    const modelFamily = modelId.split('.')[0];
    
    // Separate system message
    let systemMessage = '';
    const conversationMessages: OpenAIMessage[] = [];
    
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemMessage += (systemMessage ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
      } else {
        conversationMessages.push(msg);
      }
    }
    
    const baseMessages = conversationMessages.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: typeof msg.content === 'string' ? msg.content : '',
    }));
    
    const maxTokens = request.max_tokens || 4096;
    const stopSequences = request.stop ? 
      (Array.isArray(request.stop) ? request.stop : [request.stop]) : 
      undefined;
    
    return {
      anthropic: {
        system: systemMessage || undefined,
        messages: baseMessages as Array<{ role: string; content: string }>,
        max_tokens: maxTokens,
        temperature: request.temperature,
        stop_sequences: stopSequences,
      },
      ai21: {
        messages: baseMessages as Array<{ role: string; content: string }>,
        maxTokens,
        temperature: request.temperature,
        stopSequences,
      },
      llama: {
        messages: baseMessages as Array<{ role: string; content: string }>,
        max_gen_len: maxTokens,
        temperature: request.temperature,
      },
      mistral: {
        messages: baseMessages as Array<{ role: string; content: string }>,
        max_tokens: maxTokens,
        temperature: request.temperature,
      },
      modelId,
    };
  }
  
  private determineModelKey(model: string): string {
    const normalizedModel = model.toLowerCase();
    
    if (normalizedModel.includes('claude-3-opus') || normalizedModel === 'opus') {
      return 'claude-3-opus';
    }
    if (normalizedModel.includes('claude-3-sonnet') || normalizedModel === 'sonnet') {
      return 'claude-3-sonnet';
    }
    if (normalizedModel.includes('claude-3-haiku') || normalizedModel === 'haiku') {
      return 'claude-3-haiku';
    }
    if (normalizedModel.includes('claude-2.1')) {
      return 'claude-2.1';
    }
    if (normalizedModel.includes('claude-2')) {
      return 'claude-2';
    }
    if (normalizedModel.includes('claude-instant')) {
      return 'claude-instant';
    }
    if (normalizedModel.includes('llama-3-70b')) {
      return 'llama-3-70b';
    }
    if (normalizedModel.includes('llama-3-8b')) {
      return 'llama-3-8b';
    }
    if (normalizedModel.includes('mistral-large')) {
      return 'mistral-large';
    }
    if (normalizedModel.includes('mistral')) {
      return 'mistral-7b';
    }
    if (normalizedModel.includes('ai21') && normalizedModel.includes('ultra')) {
      return 'ai21-j2-ultra';
    }
    if (normalizedModel.includes('ai21') || normalizedModel.includes('j2')) {
      return 'ai21-j2-mid';
    }
    
    // Default to Claude 3 Sonnet
    return 'claude-3-sonnet';
  }
  
  async callProvider(translateRequest: {
    anthropic: unknown;
    ai21: unknown;
    llama: unknown;
    mistral: unknown;
    modelId: string;
  }): Promise<ProviderResponse> {
    if (!this.client) {
      throw new Error('AWS Bedrock credentials not configured');
    }
    
    const modelId = translateRequest.modelId;
    let body: string;
    let inputTokens = 0;
    let outputTokens = 0;
    
    if (modelId.startsWith('anthropic.')) {
      body = JSON.stringify(translateRequest.anthropic);
    } else if (modelId.startsWith('ai21.')) {
      body = JSON.stringify(translateRequest.ai21);
    } else if (modelId.startsWith('meta.')) {
      body = JSON.stringify(translateRequest.llama);
    } else if (modelId.startsWith('mistral.')) {
      body = JSON.stringify(translateRequest.mistral);
    } else {
      // Default to Anthropic format
      body = JSON.stringify(translateRequest.anthropic);
    }
    
    try {
      const command = new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body,
      });
      
      const response = await this.client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      
      // Parse response based on model family
      if (modelId.startsWith('anthropic.')) {
        return {
          content: responseBody.content[0]?.text || '',
          stopReason: responseBody.stop_reason === 'end_turn' ? 'stop' : 
                      responseBody.stop_reason === 'max_tokens' ? 'length' : 
                      responseBody.stop_reason === 'content_filter' ? 'content_filter' : 'stop',
          inputTokens: responseBody.usage?.input_tokens || 0,
          outputTokens: responseBody.usage?.output_tokens || 0,
          modelId,
          rawResponse: responseBody,
        };
      } else if (modelId.startsWith('ai21.')) {
        return {
          content: responseBody.completions?.[0]?.completion?.text || '',
          stopReason: responseBody.completions?.[0]?.finishReason === 'length' ? 'length' : 'stop',
          inputTokens: responseBody.usage?.inputTokens || 0,
          outputTokens: responseBody.usage?.outputTokens || 0,
          modelId,
          rawResponse: responseBody,
        };
      } else if (modelId.startsWith('meta.')) {
        return {
          content: responseBody.generation || '',
          stopReason: responseBody.stop_reason === 'length' ? 'length' : 'stop',
          inputTokens: estimateRequestTokens([], undefined),
          outputTokens: Math.ceil((responseBody.generation?.length || 0) / 4),
          modelId,
          rawResponse: responseBody,
        };
      } else if (modelId.startsWith('mistral.')) {
        return {
          content: responseBody.outputs?.[0]?.text || '',
          stopReason: responseBody.outputs?.[0]?.stop_reason === 'length' ? 'length' : 'stop',
          inputTokens: estimateRequestTokens([], undefined),
          outputTokens: Math.ceil((responseBody.outputs?.[0]?.text?.length || 0) / 4),
          modelId,
          rawResponse: responseBody,
        };
      }
      
      // Default fallback
      return {
        content: responseBody.content?.[0]?.text || responseBody.choices?.[0]?.message?.content || '',
        stopReason: 'stop',
        inputTokens: 0,
        outputTokens: 0,
        modelId,
        rawResponse: responseBody,
      };
    } catch (error: any) {
      if (error.name === 'AccessDeniedException') {
        throw new Error(`AWS Bedrock access denied. Please ensure model access is enabled: ${modelId}`);
      }
      throw error;
    }
  }
  
  estimateTokens(messages: OpenAIMessage[], model: string): { inputTokens: number } {
    return {
      inputTokens: estimateRequestTokens(messages),
    };
  }
}
