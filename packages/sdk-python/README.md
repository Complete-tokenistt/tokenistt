# tokenistt

A **drop-in Python replacement for the `openai` library** that routes traffic to
the Tokenistt gateway instead of OpenAI. It mirrors `openai.OpenAI` /
`openai.AsyncOpenAI` and adds **auto-retry with exponential backoff**, **built-in
cost tracking**, **budget warnings**, and **per-user / per-cost-center
attribution**.

```python
import tokenistt

client = tokenistt.OpenAI(
    api_key="tk_...",
    base_url="https://gateway.tokenistt.ai/v1",  # your gateway

    # attribution
    user="team-frontend",       # X-Tokenistt-User on every request
    cost_center="product-search",

    # cost tracking
    on_usage=lambda cost: print(f"${cost:.6f}"),

    # budget control
    budget={"softLimit": 10, "hardLimit": 25},
)

client.on("usage", lambda e: print(e.cumulative_cost))
client.on("budget:warning", lambda e: print("approaching budget", e))
client.on("budget:exceeded", lambda e: print("budget exceeded", e))

completion = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(completion.choices[0].message.content)
```

Swap `import openai` → `import tokenistt` and `openai.OpenAI` →
`tokenistt.OpenAI`; existing code keeps working.

---

## Requirements

- Python **>= 3.8**
- `httpx` and `pydantic` (installed automatically)

## Install

```bash
pip install tokenistt
```

## API

### `OpenAI` / `AsyncOpenAI`

```python
client = tokenistt.OpenAI(
    api_key=...,
    base_url="https://gateway.tokenistt.ai/v1",
    organization=None, project=None,
    user=None,            # default attribution user (X-Tokenistt-User)
    cost_center=None,     # default cost-center override
    timeout=600.0,        # per-request timeout (seconds)
    max_retries=2,        # automatic retries with backoff
    pricing=None,         # override per-token prices (USD / 1M tokens)
    budget=None,          # {"softLimit", "hardLimit", "warnAtFraction"}
    on_usage=None,        # Callable[[float], None] — called with per-request cost
    throw_on_budget_exceeded=False,  # block requests once hardLimit hit
    currency="USD",
    default_headers=None, default_query=None,
)
```

Resources (mirror `openai`):

- `client.chat.completions.create(...)` → `ChatCompletion` | `Stream`
- `client.embeddings.create(...)`
- `client.models.list()` / `.retrieve(id)` / `.delete(id)`
- `client.moderations.create(...)`
- `client.completions.create(...)` (legacy)

#### Context managers

```python
with tokenistt.OpenAI(...) as client:        # sync
    ...

async with tokenistt.AsyncOpenAI(...) as client:   # async
    ...
```

### Attribution (the differentiator)

`user` / `cost_center` can be set per client **or per request** (the request
value overrides the client default and is sent as `X-Tokenistt-User` /
`X-Tokenistt-Cost-Center`):

```python
# per-request override
client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "hi"}],
    user="alice",          # attribution override
    cost_center="onboarding",
)

# or clone the client with new defaults
scoped = client.with_options(user="alice", cost_center="onboarding")
```

> Note: OpenAI's own body-level `user` field is distinct from attribution.
> If you need it, pass it via `extra_body={"user": "<openai-id>"}`.

### Streaming (sync & async)

```python
stream = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Count to 5."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")

# cost metadata is available once the stream is exhausted:
print("cost:", stream.cost, "usage:", stream.usage)
full = stream.get_final_completion()   # reconstructs the ChatCompletion
```

Async is identical with `AsyncOpenAI` and `async for` / `await stream.get_final_completion()`.

### Cost tracking & budget

- `on_usage(cost)` is called after every billable response with the request
  cost (USD).
- The client also emits richer events whose payloads are `UsageEvent`
  pydantic models: `usage`, `budget:warning`, `budget:exceeded`, plus
  `request`, `response`, `retry`.
- `budget:warning` fires once when cumulative spend reaches `softLimit` (or
  `warnAtFraction × hardLimit`, default 0.8).
- `budget:exceeded` fires once when cumulative spend reaches `hardLimit`.
- With `throw_on_budget_exceeded=True`, a `BudgetExceededError` is raised
  *before* the request is sent once the hard limit is reached.

```python
client.on("usage", lambda e: analytics.report(e))
client.on("budget:exceeded", lambda e: pagerduty.trigger(e))
print("total spend:", client.get_cumulative_cost())
```

### Automatic retry

Network errors and HTTP `408/409/425/429/500/502/503/504` are retried with
exponential backoff + jitter (base 500 ms, capped at 60 s). A `Retry-After`
header is honored. Abort via `client.close()` / context-manager exit.

## Gateway contract

The SDK sets these headers on every request:

| Header | Source |
| --- | --- |
| `Authorization: Bearer <apiKey>` | `api_key` |
| `X-Tokenistt-User` | `user` (client default or per-request) |
| `X-Tokenistt-Cost-Center` | `cost_center` (client default or per-request) |
| `X-Tokenistt-SDK-Version` | package version |
| `OpenAI-Organization` / `OpenAI-Project` | `organization` / `project` |

Any path, query, and body are forwarded verbatim to `base_url`, so the gateway
controls routing, model mapping, and fallbacks. The SDK's built-in pricing is
only used for **local** cost estimates; for authoritative billing, read
`usage` from the gateway response.

## License

MIT
