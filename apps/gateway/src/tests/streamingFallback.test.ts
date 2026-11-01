import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { streamsNatively, writeSyntheticStream } from '../services/streaming.js';

function fakeRes() {
  const out = { chunks: [] as string[], headers: {} as Record<string, string>, ended: false };
  const res: any = {
    setHeader: (k: string, v: string) => { out.headers[k] = v; },
    removeHeader: () => {},
    write: (c: string) => { out.chunks.push(c); return true; },
    end: () => { out.ended = true; },
  };
  return { res, out };
}

describe('streaming provider selection', () => {
  it('streams natively for OpenAI-style, Anthropic and compat providers', () => {
    for (const m of ['gpt-4o', 'openai:gpt-4o-mini', 'claude-3-5-sonnet', 'groq:llama-3.3-70b-versatile', 'gemini-2.0-flash']) {
      assert.equal(streamsNatively(m), true, m);
    }
  });
  it('falls back to a replayed stream for mock and Bedrock-routed models', () => {
    for (const m of ['mock:echo', 'meta.llama3-70b-instruct', 'mistral-large-2402', 'ai21.j2-mid']) {
      assert.equal(streamsNatively(m), false, m);
    }
    assert.equal(streamsNatively('gpt-4o', 'mock'), false);
    assert.equal(streamsNatively('anything', 'bedrock'), false);
  });
});

describe('writeSyntheticStream', () => {
  it('emits role, content pieces, a finish chunk with usage, then [DONE]', () => {
    const { res, out } = fakeRes();
    writeSyntheticStream(res, {
      id: 'chatcmpl-1', model: 'mock:echo', usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello brave world' }, finish_reason: 'stop' }],
    });
    assert.equal(out.headers['Content-Type'], 'text/event-stream');
    assert.ok(out.ended);
    const events = out.chunks.join('').split('\n\n').filter(Boolean);
    assert.equal(events.at(-1), 'data: [DONE]');
    const parsed = events.slice(0, -1).map(e => JSON.parse(e.slice(6)));
    assert.equal(parsed[0].choices[0].delta.role, 'assistant');
    assert.equal(parsed.slice(1, -1).map(p => p.choices[0].delta.content).join(''), 'hello brave world');
    assert.equal(parsed.at(-1).choices[0].finish_reason, 'stop');
    assert.equal(parsed.at(-1).usage.total_tokens, 7);
  });
});
