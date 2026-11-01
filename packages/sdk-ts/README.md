# @tokenistt/sdk

A **drop-in replacement for the `openai` npm package** that routes traffic to the
Tokenistt gateway instead of OpenAI. It mirrors the `openai@4.x` interface
(`new Tokenistt({ apiKey, baseURL })`, `client.chat.completions.create(...)`) and
adds **auto-retry with exponential backoff**, **built-in cost tracking**,
**budget warnings**, and **per-user / per-cost-center attribution**.

```ts
import Tokenistt from '@tokenistt/sdk';

const client = new Tokenistt({
  apiKey: process.env.TOKENISTT_API_KEY,
  baseURL: 'https://gateway.tokenistt.ai/v1', // your gateway

  // --- attribution ---
  user: 'team-frontend',        // attached to every request (X-Tokenistt-User)
  costCenter: 'product-search', // optional default cost-center override

  // --- cost tracking ---
  onUsage: (cost) => console.log(`$${cost.toFixed(6)}`),

  // --- budget control ---
  budget: { softLimit: 10, hardLimit: 25 },
});

// budget / usage events
client.on('usage', (e) => console.log(e.cumulativeCost));
client.on('budget:warning', (e) => console.warn('Approaching budget', e));
client.on('budget:exceeded', (e) => console.error('Budget exceeded', e));

const completion = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(completion.choices[0].message.content);
```

Swap `import OpenAI from 'openai'` → `import Tokenistt from '@tokenistt/sdk'` and your
existing code keeps working.

---

## Requirements

- Node.js **>= 18** (uses the built-in global `fetch`).

## Install

```bash
npm install @tokenistt/sdk
```

## API

### Constructor

```ts
new Tokenistt(options)
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | `string` | – | Sent as `Authorization: Bearer`. |
| `baseURL` | `string` | `https://api.tokenistt.ai/v1` | Your gateway base. |
| `organization` / `project` | `string` | – | Forwarded as OpenAI-compatible headers. |
| `user` | `string` | – | Default **attribution** user (header `X-Tokenistt-User`). |
| `costCenter` | `string` | – | Default cost-center override (header `X-Tokenistt-Cost-Center`). |
| `timeout` | `number` | `600000` | Per-request timeout (ms). |
| `maxRetries` | `number` | `3` | Automatic retries with backoff. |
| `pricing` | `PricingTable` | built-in | Override per-token prices (USD / 1M tokens). |
| `budget` | `BudgetConfig` | – | `{ softLimit?, hardLimit?, warnAtFraction? }`. |
| `onUsage` | `(cost: number) => void` | – | Called with the per-request cost. |
| `throwOnBudgetExceeded` | `boolean` | `false` | Block requests once `hardLimit` is reached. |
| `currency` | `string` | `'USD'` | Currency shown in events. |
| `fetch` | `typeof fetch` | global fetch | Inject a custom fetch (tests / proxies). |
| `defaultHeaders` / `defaultQuery` | `object` | – | Merged into every request. |
| `dangerouslyAllowBrowser` | `boolean` | `false` | Required to run in a browser. |

### Resources (mirrors `openai@4.x`)

- `client.chat.completions.create(body, options?)` → `ChatCompletion | ChatCompletionStream`
- `client.embeddings.create(body, options?)`
- `client.models.list()` / `models.retrieve(id)` / `models.del(id)`
- `client.moderations.create(body, options?)`
- `client.completions.create(body, options?)` (legacy)

Every resource method accepts an optional `options` bag with
`user`, `costCenter`, `timeout`, `maxRetries`, and `signal`
(AbortSignal). Per-request `user` / `costCenter` override the client defaults.

### Streaming

```ts
const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Count to 5.' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
// Cost is tracked automatically (the gateway is asked for usage in the
// final chunk). Reconstruct the full completion at any time:
const full = await stream.finalChatCompletion();
console.log(full.usage);
```

### Cost tracking & budget

- **`onUsage(cost)`** is called after every billable response with the request cost (USD).
- The client also emits a richer **`usage`** event: `{ cost, cumulativeCost, currency, model, promptTokens, completionTokens, totalTokens, user, costCenter, requestId }`.
- **`budget:warning`** fires once when cumulative spend reaches `softLimit`
  (or `warnAtFraction` × `hardLimit`, default 0.8).
- **`budget:exceeded`** fires once when cumulative spend reaches `hardLimit`.
- With `throwOnBudgetExceeded: true`, a `BudgetExceededError` is thrown *before*
  the request is sent once the hard limit is reached.

```ts
client.on('usage', (e) => reportToAnalytics(e));
client.on('budget:exceeded', (e) => pageOnCall(e));
```

### Automatic retry

Network errors and HTTP `408/409/425/429/500/502/503/504` are retried with
exponential backoff + jitter (base 500 ms, capped at 60 s). A `Retry-After`
header is honored. Abort via an `AbortSignal` to stop retries immediately.

## Gateway contract

The SDK sets these headers on every request:

| Header | Source |
| --- | --- |
| `Authorization: Bearer <apiKey>` | `apiKey` |
| `X-Tokenistt-User` | `user` (client default or per-request) |
| `X-Tokenistt-Cost-Center` | `costCenter` (client default or per-request) |
| `X-Tokenistt-SDK-Version` | package version |
| `OpenAI-Organization` / `OpenAI-Project` | `organization` / `project` |

Any path, query, and body are forwarded verbatim to `baseURL`, so the gateway
controls routing, model mapping, fallbacks, and the per-token pricing used for
attribution. The SDK's built-in pricing is only used for **local** cost estimates;
for authoritative billing, read `usage` from the gateway response.

## License

Apache-2.0
