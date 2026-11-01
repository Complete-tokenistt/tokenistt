/* eslint-disable */
// Live test: drives the built SDK against a REAL running gateway (no mocks).
//
//   TOKENISTT_BASE_URL=http://localhost:3000/v1 TOKENISTT_API_KEY=tktt_live_... node tests/live.cjs
//
// Uses the gateway's offline `mock:echo` model by default (MODEL=... to change). Exits non-zero on failure.
const { Tokenistt, AuthenticationError, BudgetExceededError, gatewayHeaders } = require('../dist/cjs');

const baseURL = process.env.TOKENISTT_BASE_URL;
const apiKey = process.env.TOKENISTT_API_KEY;
const model = process.env.MODEL || 'mock:echo';
if (!baseURL || !apiKey) {
  console.error('TOKENISTT_BASE_URL and TOKENISTT_API_KEY are required');
  process.exit(2);
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  -> ${detail}`}`);
  if (!ok) failed++;
};

async function main() {
  const client = new Tokenistt({
    apiKey,
    baseURL,
    attribution: { team: 'sdk-live-test', repo: 'tokenistt/sdk', feature: 'live-test' },
    maxRetries: 0,
  });
  const responses = [];
  client.on('response', (e) => responses.push(e));

  // 1. plain completion
  const c = await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'hello sdk' }] });
  check('chat completion returns the reply', c.choices[0].message.content === 'mock reply: hello sdk', JSON.stringify(c.choices));
  check('usage is present', c.usage && c.usage.total_tokens > 0, JSON.stringify(c.usage));
  check('gateway cost header is exposed', responses.some((r) => r.headers['x-tokenistt-cost'] !== undefined), JSON.stringify(responses[0]?.headers));
  check('SDK tracked a cumulative cost', client.getCumulativeCost() > 0, String(client.getCumulativeCost()));

  // 2. streaming
  const stream = await client.chat.completions.create({ model, stream: true, messages: [{ role: 'user', content: 'stream me' }] });
  let text = '';
  for await (const chunk of stream) text += chunk.choices?.[0]?.delta?.content ?? '';
  check('streaming delivers the full reply', text === 'mock reply: stream me', JSON.stringify(text));

  // 3. attribution headers reach the gateway (they come back on the request log)
  const logs = await fetch(`${baseURL.replace(/\/v1$/, '')}/v1/logs?limit=5`, { headers: { authorization: `Bearer ${apiKey}` } });
  const body = await logs.json().catch(() => ({}));
  const rows = body.data ?? body.logs ?? [];
  check('request shows up in the key\'s history', logs.ok && rows.length > 0, `${logs.status} ${JSON.stringify(body).slice(0, 160)}`);

  // 3b. usage() reports this key's spend
  const u = await client.usage();
  check('usage() reports spend, requests and top models', u.month.requests >= 2 && u.month.cost_usd > 0 && u.today.requests >= 2 && Array.isArray(u.top_models), JSON.stringify(u).slice(0, 200));

  // 4. helper builds the documented headers
  const h = gatewayHeaders({ attribution: { team: 'a' }, cache: true });
  check('gatewayHeaders builds x-tokenistt-* headers', h['x-tokenistt-team'] === 'a' && h['x-tokenistt-cache'] === 'true');

  // 5. bad key -> typed error
  let err;
  try {
    await new Tokenistt({ apiKey: 'tktt_live_not_a_real_key', baseURL, maxRetries: 0 }).chat.completions.create({ model, messages: [{ role: 'user', content: 'x' }] });
  } catch (e) { err = e; }
  check('invalid key raises AuthenticationError', err instanceof AuthenticationError, String(err));

  // 6. client-side hard budget stops before the network
  const capped = new Tokenistt({ apiKey, baseURL, maxRetries: 0, throwOnBudgetExceeded: true, budget: { hardLimit: 0.0000001 } });
  await capped.chat.completions.create({ model, messages: [{ role: 'user', content: 'spend a little' }] });
  let blocked;
  try {
    await capped.chat.completions.create({ model, messages: [{ role: 'user', content: 'again' }] });
  } catch (e) { blocked = e; }
  check('hard budget throws BudgetExceededError on the next call', blocked instanceof BudgetExceededError, String(blocked));
}

main()
  .then(() => {
    console.log(failed ? `\n${failed} check(s) failed` : '\nALL OK');
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('LIVE TEST ERROR:', e);
    process.exit(1);
  });
