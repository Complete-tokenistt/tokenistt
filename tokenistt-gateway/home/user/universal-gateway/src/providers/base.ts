import { 
  OpenAIChatCompletionRequest, 
  ProviderResponse,
  OpenAIMessage 
} from '../types/index.js';

export interface ProviderAdapter {
  name: string;
  
  // Check if this adapter can handle the request
  canHandle(model: string): boolean;
  
  // Translate OpenAI request format to provider-specific format
  translateRequest(request: OpenAIChatCompletionRequest): Promise<unknown>;
  
  // Make the actual API call to the provider
  callProvider(translateRequest: unknown): Promise<ProviderResponse>;
  
  // Parse provider response into unified format
  parseResponse(response: ProviderResponse): {
    content: string;
    finishReason: string;
  };
  
  // Estimate tokens for cost calculation (when not provided by provider)
  estimateTokens(messages: OpenAIMessage[], model: string): {
    inputTokens: number;
  };
}

// Base class with common utilities
export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract name: string;
  
  canHandle(model: string): boolean {
    return false;
  }
  
  abstract translateRequest(request: OpenAIChatCompletionRequest): Promise<unknown>;
  
  abstract callProvider(request: unknown): Promise<ProviderResponse>;
  
  parseResponse(response: ProviderResponse) {
    return {
      content: response.content,
      finishReason: response.stopReason === 'stop' ? 'stop' : 
                    response.stopReason === 'length' ? 'length' : 
                    response.stopReason === 'content_filter' ? 'content_filter' : 'stop',
    };
  }
  
  estimateTokens(messages: OpenAIMessage[], model: string): { inputTokens: number } {
    // Simple estimation: ~4 chars per token for English
    const totalChars = messages.reduce((sum, msg) => {
      return sum + (typeof msg.content === 'string' ? msg.content.length : 0);
    }, 0);
    return {
      inputTokens: Math.ceil(totalChars / 4),
    };
  }
}

// Token estimation utilities
export function estimateMessageTokens(message: OpenAIMessage): number {
  const content = typeof message.content === 'string' ? message.content : '';
  
  // Base tokens for message structure
  let tokens = 4; // overhead per message
  
  // Tokens for role
  if (message.role) {
    tokens += message.role.length + 1;
  }
  
  // Tokens for content (rough: 1 token per 4 characters)
  tokens += Math.ceil(content.length / 4);
  
  // Tokens for name if present
  if (message.name) {
    tokens += message.name.length + 1;
  }
  
  // Tokens for tool calls
  if (message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      tokens += JSON.stringify(toolCall).length / 4;
    }
  }
  
  return tokens;
}

export function estimateRequestTokens(
  messages: OpenAIMessage[],
  tools?: OpenAIChatCompletionRequest['tools']
): number {
  let tokens = 3; // Base overhead
  
  for (const message of messages) {
    tokens += estimateMessageTokens(message);
  }
  
  // Add tokens for tool definitions if present
  if (tools) {
    for (const tool of tools) {
      tokens += JSON.stringify(tool).length / 4;
    }
  }
  
  return tokens;
}
