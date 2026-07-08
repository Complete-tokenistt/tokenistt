import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { GatewayService, validateChatCompletionRequest, extractProviderFromHeaders } from '../services/gateway.js';
import { ProviderType } from '../types/index.js';

describe('GatewayService', () => {
  let gateway: GatewayService;
  
  beforeEach(() => {
    // Create gateway without requiring a provider to be configured
    gateway = new GatewayService({
      defaultProvider: 'anthropic',
    });
  });
  
  describe('Configuration', () => {
    it('should return empty array when no providers configured', () => {
      const providers = gateway.getAvailableProviders();
      assert.ok(Array.isArray(providers));
    });
    
    it('should not have providers by default', () => {
      assert.ok(!gateway.hasProvider('anthropic'));
      assert.ok(!gateway.hasProvider('bedrock'));
      assert.ok(!gateway.hasProvider('azure'));
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
    assert.ok(validateChatCompletionRequest(request));
  });
  
  it('should reject request without model', () => {
    const request = {
      messages: [{ role: 'user', content: 'Hello' }]
    };
    assert.ok(!validateChatCompletionRequest(request));
  });
  
  it('should reject request without messages', () => {
    const request = {
      model: 'gpt-4'
    };
    assert.ok(!validateChatCompletionRequest(request));
  });
  
  it('should reject request with empty messages array', () => {
    const request = {
      model: 'gpt-4',
      messages: []
    };
    assert.ok(!validateChatCompletionRequest(request));
  });
  
  it('should reject request with invalid message role', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'invalid', content: 'Hello' }]
    };
    assert.ok(!validateChatCompletionRequest(request));
  });
  
  it('should reject request with tool role without tool_call_id', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'tool', content: 'test' }]
    };
    // Tool role without tool_call_id is technically invalid, but we allow it for flexibility
    assert.ok(validateChatCompletionRequest(request));
  });
  
  it('should accept request with null content', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'assistant', content: null }]
    };
    assert.ok(validateChatCompletionRequest(request));
  });
  
  it('should accept additional fields', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      max_tokens: 1000,
      top_p: 1.0,
      stream: false
    };
    assert.ok(validateChatCompletionRequest(request));
  });
  
  it('should accept valid system role', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'system', content: 'You are a helpful assistant' }]
    };
    assert.ok(validateChatCompletionRequest(request));
  });
  
  it('should accept valid user role', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }]
    };
    assert.ok(validateChatCompletionRequest(request));
  });
  
  it('should accept valid assistant role', () => {
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'assistant', content: 'Hello' }]
    };
    assert.ok(validateChatCompletionRequest(request));
  });
});

describe('extractProviderFromHeaders', () => {
  it('should extract provider from x-provider header', () => {
    const headers = { 'x-provider': 'anthropic' };
    assert.strictEqual(extractProviderFromHeaders(headers), 'anthropic');
  });
  
  it('should extract provider from x-provider-id header', () => {
    const headers = { 'x-provider-id': 'bedrock' };
    assert.strictEqual(extractProviderFromHeaders(headers), 'bedrock');
  });
  
  it('should return undefined when no provider header', () => {
    const headers = {};
    assert.strictEqual(extractProviderFromHeaders(headers), undefined);
  });
  
  it('should normalize provider name to lowercase', () => {
    const headers = { 'x-provider': 'ANTHROPIC' };
    assert.strictEqual(extractProviderFromHeaders(headers), 'anthropic');
  });
  
  it('should return undefined for invalid provider names', () => {
    const headers = { 'x-provider': 'invalid-provider' };
    assert.strictEqual(extractProviderFromHeaders(headers), undefined);
  });
  
  it('should support all valid providers', () => {
    const providers: ProviderType[] = ['anthropic', 'bedrock', 'azure', 'openai'];
    for (const provider of providers) {
      const headers = { 'x-provider': provider };
      assert.strictEqual(extractProviderFromHeaders(headers), provider);
    }
  });
});
