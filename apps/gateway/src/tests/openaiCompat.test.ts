import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GroqAdapter, TogetherAdapter, OllamaAdapter, GeminiAdapter } from '../providers/openaiCompat.js';
import { ProviderRegistry } from '../providers/registry.js';

let server: http.Server;
let base = '';
let lastAuth: string | undefined;
let lastBody: any;

before(async () => {
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization;
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw || '{}');
      if (req.url === '/bad/chat/completions') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'slow down' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: lastBody.model,
        choices: [{ message: { content: 'hi' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

const req = (model: string) => ({ model, messages: [{ role: 'user' as const, content: 'yo' }] });

describe('OpenAI-compatible adapters', () => {
  it('Groq: strips prefix, sends bearer key, maps usage + finish reason', async () => {
    process.env.GROQ_BASE_URL = base;
    const a = new GroqAdapter('gsk_test');
    const out = await a.callProvider(a.translateRequest(req('groq:llama-3.3-70b')));
    assert.equal(lastBody.model, 'llama-3.3-70b');
    assert.equal(lastAuth, 'Bearer gsk_test');
    assert.deepEqual([out.inputTokens, out.outputTokens, out.stopReason], [7, 3, 'length']);
  });

  it('BYOK override key wins over default key', async () => {
    process.env.TOGETHER_BASE_URL = base;
    const a = new TogetherAdapter('default');
    await a.callProvider(a.translateRequest(req('together:meta/x')), 'byok');
    assert.equal(lastAuth, 'Bearer byok');
  });

  it('Ollama works without an API key (no Authorization header)', async () => {
    process.env.OLLAMA_BASE_URL = base;
    const a = new OllamaAdapter();
    await a.callProvider(a.translateRequest(req('ollama:llama3')));
    assert.equal(lastAuth, undefined);
  });

  it('keyed providers throw when no credentials', async () => {
    delete process.env.GROQ_API_KEY;
    const a = new GroqAdapter();
    await assert.rejects(a.callProvider({ model: 'x' }), /credentials not configured/);
  });

  it('maps 429 to a rate-limit error', async () => {
    process.env.GEMINI_BASE_URL = `${base}/bad`;
    const a = new GeminiAdapter('k');
    await assert.rejects(a.callProvider(a.translateRequest(req('gemini-2.0-flash'))), /rate limit exceeded: slow down/);
  });

  it('registry routes by prefix/hint and registers from env', () => {
    process.env.GROQ_API_KEY = 'gsk_x';
    process.env.GEMINI_API_KEY = 'g';
    process.env.OLLAMA_BASE_URL = base;
    const r = new ProviderRegistry();
    assert.equal(r.detectProvider('groq:llama'), 'groq');
    assert.equal(r.detectProvider('gemini-2.0-flash'), 'gemini');
    assert.equal(r.detectProvider('ollama:llama3'), 'ollama');
    assert.equal(r.detectProvider('together:foo'), 'together');
    assert.ok(r.hasProvider('groq') && r.hasProvider('gemini') && r.hasProvider('ollama'));
    assert.ok(!r.hasProvider('together'));
    r.updateCompatConfig('together', 'tk');
    assert.ok(r.hasProvider('together'));
  });
});
