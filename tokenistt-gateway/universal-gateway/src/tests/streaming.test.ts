import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import { Readable } from 'stream';
import { handleStreamingCompletion } from '../services/streaming.js';
import { AuthContext } from '../db/auth.js';
import { setMockLogger } from '../db/transactionLogger.js';

describe('Streaming passthrough', () => {
  let originalPost: any;
  let loggedTransaction: any = null;

  beforeEach(() => {
    originalPost = axios.post;
    loggedTransaction = null;
    // Set custom mock logger
    setMockLogger(async (tx: any) => {
      loggedTransaction = tx;
      return 'mock-tx-id';
    });
  });

  afterEach(() => {
    axios.post = originalPost;
    setMockLogger(null);
  });

  it('should stream OpenAI chunks and calculate final cost', async () => {
    const mockStream = new Readable({
      read() {}
    });

    axios.post = (async () => {
      return {
        data: mockStream
      };
    }) as any;

    const mockRes: any = {
      headers: {} as Record<string, string>,
      written: [] as string[],
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      write(chunk: string) {
        this.written.push(chunk);
      },
      end() {
        this.ended = true;
      },
      ended: false
    };

    const mockAuth: AuthContext = {
      actor: 'sarah@acme.io',
      costCenter: 'engineering',
      organizationId: 1n,
      workspaceId: 10n,
      virtualKeyId: 100n,
      virtualKeyPublicId: 'tktt_live_abc',
      budgetCapUsd: 100.0,
      budgetUsedUsd: 10.0,
      budgetPeriod: 'monthly',
      allowedProviders: ['openai'],
      realApiKey: 'sk-real-openai-key'
    };

    const request = {
      model: 'openai:gpt-4o',
      messages: [{ role: 'user' as const, content: 'Hello' }],
      stream: true
    };

    const promise = handleStreamingCompletion(request, mockRes, mockAuth, 'openai', 'test-request-id');

    // Simulate sending OpenAI stream chunks
    mockStream.push('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    mockStream.push('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    mockStream.push('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
    mockStream.push('data: [DONE]\n\n');
    mockStream.push(null); // End stream

    await promise;

    assert.ok(mockRes.ended);
    assert.strictEqual(mockRes.headers['Content-Type'], 'text/event-stream');
    
    // Check written chunks
    assert.ok(mockRes.written.length >= 3);
    assert.ok(mockRes.written.some((w: string) => w.includes('Hello')));
    assert.ok(mockRes.written.some((w: string) => w.includes('world')));
    assert.ok(mockRes.written.some((w: string) => w.includes('[DONE]')));

    // Check transaction logger payload
    assert.ok(loggedTransaction !== null);
    assert.strictEqual(loggedTransaction.requestId, 'test-request-id');
    assert.strictEqual(loggedTransaction.promptTokens, 10);
    assert.strictEqual(loggedTransaction.completionTokens, 5);
    assert.strictEqual(loggedTransaction.provider, 'openai');
    assert.ok(loggedTransaction.costUsd > 0);
  });

  it('should stream Anthropic chunks, translate to OpenAI format, and log transaction', async () => {
    const mockStream = new Readable({
      read() {}
    });

    axios.post = (async () => {
      return {
        data: mockStream
      };
    }) as any;

    const mockRes: any = {
      headers: {} as Record<string, string>,
      written: [] as string[],
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      write(chunk: string) {
        this.written.push(chunk);
      },
      end() {
        this.ended = true;
      },
      ended: false
    };

    const mockAuth: AuthContext = {
      actor: 'bob@acme.io',
      costCenter: 'marketing',
      organizationId: 2n,
      workspaceId: 20n,
      virtualKeyId: 200n,
      virtualKeyPublicId: 'tktt_live_xyz',
      budgetCapUsd: 50.0,
      budgetUsedUsd: 5.0,
      budgetPeriod: 'monthly',
      allowedProviders: ['anthropic'],
      realApiKey: 'sk-real-anthropic-key'
    };

    const request = {
      model: 'claude-3-sonnet',
      messages: [{ role: 'user' as const, content: 'Hello' }],
      stream: true
    };

    const promise = handleStreamingCompletion(request, mockRes, mockAuth, 'anthropic', 'anthropic-request-id');

    // Simulate sending Anthropic stream chunks
    mockStream.push('data: {"type":"message_start","message":{"usage":{"input_tokens":15},"model":"claude-3-5-sonnet-20241022"}}\n\n');
    mockStream.push('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi there!"}}\n\n');
    mockStream.push('data: {"type":"message_delta","usage":{"output_tokens":8}}\n\n');
    mockStream.push('data: {"type":"message_stop"}\n\n');
    mockStream.push(null); // End stream

    await promise;

    assert.ok(mockRes.ended);
    
    // Check that response contains translated OpenAI chunks
    assert.ok(mockRes.written.length >= 3);
    const hasTranslation = mockRes.written.some((w: string) => {
      try {
        if (!w.startsWith('data:')) return false;
        const body = JSON.parse(w.slice(5).trim());
        return body.object === 'chat.completion.chunk' && body.choices?.[0]?.delta?.content === 'Hi there!';
      } catch {
        return false;
      }
    });
    assert.ok(hasTranslation);

    // Check transaction logger payload
    assert.ok(loggedTransaction !== null);
    assert.strictEqual(loggedTransaction.requestId, 'anthropic-request-id');
    assert.strictEqual(loggedTransaction.promptTokens, 15);
    assert.strictEqual(loggedTransaction.completionTokens, 8);
    assert.strictEqual(loggedTransaction.provider, 'anthropic');
    assert.ok(loggedTransaction.costUsd > 0);
  });
});
