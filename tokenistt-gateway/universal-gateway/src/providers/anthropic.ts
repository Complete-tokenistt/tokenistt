import { Anthropic } from '@anthropic-ai/sdk';
import { 
  OpenAIChatCompletionRequest, 
  ProviderResponse,
  OpenAIMessage 
} from '../types/index.js';
import { BaseProviderAdapter, estimateRequestTokens } from './base.js';

const MODEL_MAP: Record<string, string> = {
  'gpt-4': 'claude-3-sonnet',
  'gpt-4-turbo': 'claude-3-sonnet',
  'gpt-3.5-turbo': 'claude-3-haiku',
  'claude-3-opus': 'claude-3-opus',
  'claude-3-sonnet': 'claude-3-sonnet',
  'claude-3-haiku': 'claude-3-haiku',
  'claude-2.1': 'claude-2.1',
  'claude-2.0': 'claude-2.0',
  'claude-instant': 'claude-instant',
};

export class AnthropicAdapter extends BaseProviderAdapter {
  name = 'anthropic';
  private client: Anthropic | null = null;
  
  constructor(apiKey?: string) {
    super();
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }
  
  setApiKey(apiKey: string): void {
    this.client = new Anthropic({ apiKey });
  }
  
  canHandle(model: string): boolean {
    const normalizedModel = model.toLowerCase();
    return (
      normalizedModel.startsWith('claude') ||
      normalizedModel.includes('claude') ||
      normalizedModel === 'gpt-4' ||
      normalizedModel === 'gpt-4-turbo' ||
      normalizedModel === 'gpt-3.5-turbo'
    );
  }
  
  translateRequest(request: OpenAIChatCompletionRequest): unknown {
    let systemMessage = '';
    const conversationMessages: OpenAIMessage[] = [];
    
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemMessage += (systemMessage ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
      } else {
        conversationMessages.push(msg);
      }
    }
    
    const anthropicMessages = conversationMessages.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: typeof msg.content === 'string' ? msg.content : '',
    }));
    
    let maxTokens = request.max_tokens || 4096;
    if (maxTokens > 8192) {
      maxTokens = 8192;
    }
    
    return {
      messages: anthropicMessages,
      max_tokens: maxTokens,
      temperature: request.temperature,
      system: systemMessage || undefined,
      stop_sequences: request.stop ? 
        (Array.isArray(request.stop) ? request.stop : [request.stop]) : 
        undefined,
    };
  }
  
  async callProvider(translateRequest: unknown): Promise<ProviderResponse> {
    if (!this.client) {
      throw new Error('Anthropic API key not configured');
    }
    
    const req = translateRequest as {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      max_tokens: number;
      temperature?: number;
      system?: string;
      stop_sequences?: string[];
    };
    
    const response = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages: req.messages as any,
      max_tokens: req.max_tokens,
      temperature: req.temperature,
      system: req.system as any,
      stop_sequences: req.stop_sequences,
    });
    
    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as any).text)
      .join('');
    
    let stopReason: 'stop' | 'length' | 'content_filter' = 'stop';
    const stopReasonValue = response.stop_reason as string;
    if (stopReasonValue === 'end_turn') {
      stopReason = 'stop';
    } else if (stopReasonValue === 'max_tokens') {
      stopReason = 'length';
    } else if (stopReasonValue === 'content_filter' || stopReasonValue === 'refusal') {
      stopReason = 'content_filter';
    }
    
    return {
      content,
      stopReason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      modelId: response.model,
      rawResponse: response,
    };
  }
  
  parseResponse(response: ProviderResponse) {
    return {
      content: response.content,
      finishReason: response.stopReason === 'stop' ? 'stop' : 
                    response.stopReason === 'length' ? 'length' : 
                    response.stopReason === 'content_filter' ? 'content_filter' : 'stop',
    };
  }
  
  estimateTokens(messages: OpenAIMessage[], model: string): { inputTokens: number } {
    return {
      inputTokens: estimateRequestTokens(messages),
    };
  }
}
