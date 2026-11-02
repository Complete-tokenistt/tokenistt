/* eslint-disable */
// Runtime smoke test for the built SDK. Run: node tests/smoke.cjs
const { Tokenistt, BudgetExceededError, AuthenticationError } = require('../dist/cjs');

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

async function main() {
  // --- 1. non-streaming + cost tracking + attribution headers ---
  let usageCalls = [];
  const client = new Tokenistt({
    apiKey: 'sk-test',
    baseURL: 'https://fake.local/v1',
    user: 'tester',
    costCenter: 'cc1',
    onUsage: (c) => usageCalls.push(c),
    budget: { softLimit: 0.000001 },
  });
  client.on('budget:warning', () => console.log('  [event] budget:warning'));
  client.on('usage', (e) => console.log('  [event] usage', e.cost.toFixed(8), 'cum', e.cumulativeCost.toFixed(8)));

  client.fetchFn = async (url, init) => {
    console.log('  URL', url, '| AUTH', init.headers['Authorization'], '| USER', init.headers['X-Tokenistt-User'], '| CC', init.headers['X-Tokenistt-Cost-Center']);
    return jsonResponse({
      id: 'cmpl_1', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi there!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  };

  const c = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  console.log('1. content =', c.choices[0].message.content, '| usage =', JSON.stringify(c.usage));
  console.log('   cumulative =', client.getCumulativeCost().toFixed(8), '| onUsage calls =', usageCalls.length);

  // --- 2. streaming with finalChatCompletion reconstruction + cost ---
  client.fetchFn = async () => {
    const chunks = [
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];
    const enc = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
        else controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const stream = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true });
  let out = '';
  for await (const ch of stream) out += ch.choices[0]?.delta?.content || '';
  const full = await stream.finalChatCompletion();
  console.log('2. streamed =', out, '| final.content =', full.choices[0].message.content, '| final.usage =', JSON.stringify(full.usage));

  // --- 3. retry on 500 then success ---
  let attempts = 0;
  client.fetchFn = async () => {
    attempts++;
    if (attempts < 3) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    return jsonResponse({ id: 'r', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  };
  let retries = 0;
  client.on('retry', (e) => { retries++; console.log('  [event] retry', e.attempt, 'delay', e.delayMs); });
  const r = await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
  console.log('3. retry result =', r.choices[0].message.content, '| attempts =', attempts, '| retry events =', retries);

  // --- 4. budget hard-stop (throwOnBudgetExceeded) ---
  const strict = new Tokenistt({
    apiKey: 'x',
    budget: { hardLimit: 0.0000001 },
    throwOnBudgetExceeded: true,
    onUsage: () => {},
    fetch: async () => jsonResponse({ id: 'e', object: 'chat.completion', created: 1, model: 'gpt-4', choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } }),
  });
  await strict.chat.completions.create({ model: 'gpt-4', messages: [{ role: 'user', content: 'x' }] }); // first passes, pushes over limit
  try {
    await strict.chat.completions.create({ model: 'gpt-4', messages: [{ role: 'user', content: 'x' }] });
    console.log('  ERROR: should have thrown BudgetExceededError');
    process.exit(1);
  } catch (e) {
    console.log('4. blocked as expected:', e.name, '| cumulative =', strict.getCumulativeCost().toFixed(6));
  }

  // --- 5. regressions found by the gateway e2e ---
  // 5a. a 401 stays a typed AuthenticationError (it used to be re-wrapped as APIConnectionError)
  const authed = new Tokenistt({
    apiKey: 'bad',
    maxRetries: 0,
    fetch: async () => new Response(JSON.stringify({ error: { message: 'no such key' } }), { status: 401, headers: { 'content-type': 'application/json' } }),
  });
  try {
    await authed.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof AuthenticationError)) { console.error('  ERROR: expected AuthenticationError, got', e && e.name); process.exit(1); }
  }
  // 5b. several SSE events in one network read are all delivered
  const chunk = (content) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
  const sse = new Tokenistt({ apiKey: 'x', fetch: async () => new Response(chunk('a') + chunk('b') + chunk('c') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  const st = await sse.chat.completions.create({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] });
  let text = '';
  for await (const ch of st) text += ch.choices?.[0]?.delta?.content ?? '';
  if (text !== 'abc') { console.error('  ERROR: stream lost events, got', JSON.stringify(text)); process.exit(1); }
  // 5c. the gateway-reported cost beats the client's price table (a model it does not list would cost $0)
  const priced = new Tokenistt({
    apiKey: 'x',
    fetch: async () => jsonResponse(
      { id: 'p', object: 'chat.completion', created: 1, model: 'mock:echo', choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      { headers: { 'x-tokenistt-cost': '0.000123' } },
    ),
  });
  await priced.chat.completions.create({ model: 'mock:echo', messages: [{ role: 'user', content: 'x' }] });
  if (priced.getCumulativeCost() !== 0.000123) { console.error('  ERROR: expected gateway cost, got', priced.getCumulativeCost()); process.exit(1); }
  console.log('5. 401 typed, SSE batch intact, gateway cost used');

  console.log('\nALL OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
