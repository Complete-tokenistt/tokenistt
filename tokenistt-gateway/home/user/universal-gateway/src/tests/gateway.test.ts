import { describe, it, expect, beforeEach } from 'node:test';
import { GatewayService, validateChatCompletionRequest, extractProviderFromHeaders } from '../services/gateway.js';
import { ProviderType } from '../types/index.js';

describe('GatewayService', () => {
  let gateway: GatewayService;
  
  beforeEach(() => {
    gateway = new GatewayService({
      defaultProvider: 'anthropic',
    });
  });
  
  describe('Configuration', () => {
    it('should initialize with default provider', () => {
      const providers = gateway.getAvailableProviders();
      expect(providers).toBeDefined();
    });
    
    it('should allow setting default provider', () => {
      gateway.setDefaultProvider('bedrock');
      expect(gateway.hasProvider('bedrock')).toBe(false); // Not configured
    });
  });
});

describe('validateChatCompletionRequest', () => {
  it('should validate a correct request', () => {
    const request = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' }
      ]
    };
    
    expect(validateChatCompletionRequest(request)).toBe(true);
  });
  
  it('should reject request without model', () => {
    const request = {
      messages: [{ role: 'user', content: 'Hello' }]
    };
    
    expect(validateChatCompletionRequest(request)).toBe(false);
  });
  
  it('should reject request without messages', () => {
    const request = {
      model: 'gpt-4'
    };
    
    expect(validateChatCompletionRequest(request)).toBe(false);
  });
  
  it('should reject request with empty messages array', () => {
    const request = {
      model: 'gpt-4',
      messages: []
    };
    
    expect(validateChatCompletionRequest(request)).toBe(false);
  });
  
  it('should reject request with invalid message role', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'invalid', content: 'Hello' }]
    };
    
    expect(validateChatCompletionRequest(request)).toBe(false);
  });
  
  it('should accept request with null content (for assistant messages)', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'assistant', content: null }]
    };
    
    expect(validateChatCompletionRequest(request)).toBe(true);
  });
  
  it('should accept additional fields like temperature and max_tokens', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      max_tokens: 1000,
      top_p: 1.0,
      stream: false
    };
    
    expect(validateChatCompletionRequest(request)).toBe(true);
  });
});

describe('extractProviderFromHeaders', () => {
  it('should extract provider from x-provider header', () => {
    const headers = { 'x-provider': 'anthropic' };
    expect(extractProviderFromHeaders(headers)).toBe('anthropic');
  });
  
  it('should extract provider from x-provider-id header', () => {
    const headers = { 'x-provider-id': 'bedrock' };
    expect(extractProviderFromHeaders(headers)).toBe('bedrock');
  });
  
  it('should return undefined when no provider header', () => {
    const headers = {};
    expect(extractProviderFromHeaders(headers)).toBeUndefined();
  });
  
  it('should normalize provider name to lowercase', () => {
    const headers = { 'x-provider': 'ANTHROPIC' };
    expect(extractProviderFromHeaders(headers)).toBe('anthropic');
  });
  
  it('should return undefined for invalid provider names', () => {
    const headers = { 'x-provider': 'invalid-provider' };
    expect(extractProviderFromHeaders(headers)).toBeUndefined();
  });
  
  it('should support all valid providers', () => {
    const providers: ProviderType[] = ['anthropic', 'bedrock', 'azure', 'openai'];
    
    for (const provider of providers) {
      const headers = { 'x-provider': provider };
      expect(extractProviderFromHeaders(headers)).toBe(provider);
    }
  });
});
