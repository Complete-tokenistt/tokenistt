import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { Readable } from 'stream';
import { handleStreamingCompletion } from '../services/streaming.js';
import { GroqAdapter } from '../providers/openaiCompat.js';
import { AuthContext } from '../db/auth.js';
import { setMockLogger } from '../db/transactionLogger.js';

const auth: AuthContext = {
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
  realApiKey: 'sk-real-openai-key',
};

function fakeRes(): any {
  return {
    headers: {} as Record<string, string>,
    written: [] as string[],
    setHeader(n: string, v: string) { this.headers[n] = v; },
    write(c: string) { this.written.push(c); },
    end() { this.ended = true; },
    ended: false,
  };
}

describe('usage accounting', () => {
  let originalPost: any;
  let logged: any = null;

  beforeEach(() => {
    originalPost = axios.post;
    logged = null;
    setMockLogger(async (tx: any) => { logged = tx; return 'mock-tx-id'; });
  });
  afterEach(() => {
    axios.post = originalPost;
    setMockLogger(null);
  });

  it('OpenAI-compatible adapter keeps cached and reasoning tokens from the usage block', async () => {
    axios.post = (async () => ({
      data: {
        model: 'llama-3.3-70b-versatile',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 400 },
          completion_tokens_details: { reasoning_tokens: 50 },
        },
      },
    })) as any;
    const adapter = new GroqAdapter('test-key');
    const res = await adapter.callProvider(
      adapter.translateRequest({ model: 'groq:llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] } as any),
    );
    assert.equal(res.inputTokens, 1000);
    assert.equal(res.outputTokens, 200);
    assert.equal(res.cacheReadTokens, 400);
    assert.equal(res.reasoningTokens, 50);
  });

  it('streaming prices cached tokens once and flags provider-reported usage', async () => {
    const stream = new Readable({ read() {} });
    axios.post = (async () => ({ data: stream })) as any;
    const res = fakeRes();
    const p = handleStreamingCompletion(
      { model: 'openai:gpt-4o', messages: [{ role: 'user' as const, content: 'Hello' }], stream: true },
      res, auth, 'openai', 'req-cached',
    );
    stream.push('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    stream.push('data: {"usage":{"prompt_tokens":1000000,"completion_tokens":100000,"prompt_tokens_details":{"cached_tokens":400000}}}\n\n');
    stream.push('data: [DONE]\n\n');
    stream.push(null);
    await p;

    assert.equal(logged.cacheReadTokens, 400000);
    // 600k uncached x $2.50 + 400k cached x $1.25 + 100k output x $10 = $3.00 (double charging the cached part would give $4.00)
    assert.equal(logged.costUsd, 3);
    assert.equal(logged.metadata.cost_status, 'ok');
    assert.equal(logged.metadata.tokens_estimated, false);
  });

  it('streaming flags estimated tokens when the provider sends no usage', async () => {
    const stream = new Readable({ read() {} });
    axios.post = (async () => ({ data: stream })) as any;
    const p = handleStreamingCompletion(
      { model: 'openai:gpt-4o', messages: [{ role: 'user' as const, content: 'Hello' }], stream: true },
      fakeRes(), auth, 'openai', 'req-estimated',
    );
    stream.push('data: {"choices":[{"delta":{"content":"some streamed words"}}]}\n\n');
    stream.push('data: [DONE]\n\n');
    stream.push(null);
    await p;

    assert.equal(logged.metadata.tokens_estimated, true);
    assert.ok(logged.completionTokens > 0);
  });

  it('streaming records COST_UNAVAILABLE for an unpriced model instead of looking free', async () => {
    const stream = new Readable({ read() {} });
    axios.post = (async () => ({ data: stream })) as any;
    const p = handleStreamingCompletion(
      { model: 'openai:gpt-9-imaginary', messages: [{ role: 'user' as const, content: 'Hello' }], stream: true },
      fakeRes(), auth, 'openai', 'req-unpriced',
    );
    stream.push('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
    stream.push('data: [DONE]\n\n');
    stream.push(null);
    await p;

    assert.equal(logged.costUsd, 0);
    assert.equal(logged.metadata.cost_status, 'COST_UNAVAILABLE');
  });
});
