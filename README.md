<div align="center">

<img src="apps/dashboard/app/icon.png" width="84" alt="Tokenistt logo">

# Tokenistt

### AI cost visibility and governance for growing teams

One OpenAI-compatible gateway in front of every AI provider you use — spend tracking, budgets, policies,
approvals, cost-aware routing and an audit trail. **Self-hosted. Open source (Apache-2.0).**

[![CI](https://github.com/Complete-tokenistt/tokenistt/actions/workflows/ci.yml/badge.svg)](https://github.com/Complete-tokenistt/tokenistt/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-16-4169E1?logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/docker%20compose-ready-2496ED?logo=docker&logoColor=white)

[Quick start](#-quick-start) · **[User guide](docs/GUIDE.md)** · [SDKs](#-sdks) · [Editors & agents](#-editors--ai-agents) · [Features](#-what-it-does) · [Architecture](#-architecture) · [Known gaps](#-known-gaps)

</div>

> **Status: early.** The core pipeline is built and tested end to end (see [What works today](#-what-works-today) and
> [Known gaps](#-known-gaps)). Tokenistt is pre-traction software from a three-person team — there are no customers,
> certifications or benchmarks to point at, and this README does not claim any.

---

## 🚀 Quick start

You need **Docker** and **Node 20+** (Node is only used for the one-line setup script).

```bash
git clone https://github.com/Complete-tokenistt/tokenistt.git && cd tokenistt
node scripts/setup.mjs                    # writes .env with freshly generated secrets
docker compose up --build -d              # postgres, redis, migrations, gateway, dashboard
docker compose --profile demo up seed     # optional: load clearly-labelled synthetic sample data
```

| | URL | |
|---|---|---|
| 📊 **Dashboard** | http://localhost:3001 | opens straight in — **no login** by default |
| 🔌 **Gateway** (OpenAI-compatible) | http://localhost:3000/v1 | point your tools here |
| 📘 **API docs** | http://localhost:3000/v1/openapi.json | OpenAPI 3.1 |

Open the dashboard → **Get started**: it creates an API key, sends a real request and shows you the cost. The offline
`mock:` provider is on by default, so everything works **without any provider keys**. Add `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY` to `.env` (or store per-organization keys in **Providers & Keys**) to send real traffic.

> **About "no login".** `AUTH_MODE=open` (the default) makes everyone who can reach the dashboard the owner of a local
> workspace. That is right for trying it on your machine. Set `AUTH_MODE=jwt` to require sign-in, and put your own
> auth/HTTPS proxy in front before exposing it beyond localhost.

Ports are configurable with `GATEWAY_PORT`, `DASHBOARD_PORT`, `POSTGRES_PORT`, `REDIS_PORT` if something local already uses them.

**Next:** the **[User guide](docs/GUIDE.md)** walks through real traffic, budgets, policies and approvals, routing, provider keys,
attribution, MCP, hardening for non-local use, and troubleshooting.

---

## 📦 SDKs

Drop-in replacements for the OpenAI client that point at your gateway and add **automatic retries, cost tracking,
budget warnings/hard-stops and spend attribution** (team, project, repo, ticket, feature, customer …).

### Install

```bash
# Python — works today
pip install "git+https://github.com/Complete-tokenistt/tokenistt#subdirectory=packages/sdk-python"

# TypeScript / JavaScript — from a checkout of this repo
npm install && npm run build -w packages/sdk-ts && npm pack -w packages/sdk-ts
npm install ./tokenistt-sdk-0.1.0.tgz            # in your project
```

Once a release is tagged (`sdk-vX.Y.Z`, see [`release-sdk.yml`](.github/workflows/release-sdk.yml)) these become
`npm install @tokenistt/sdk` and `pip install tokenistt`.

### Configure

Both SDKs read `TOKENISTT_API_KEY` and `TOKENISTT_BASE_URL` (default `http://localhost:3000/v1`), so this is usually all you need:

```bash
export TOKENISTT_API_KEY=tktt_live_...        # create one under "API keys" in the dashboard
export TOKENISTT_BASE_URL=http://localhost:3000/v1
```

<table>
<tr><th>TypeScript</th><th>Python</th></tr>
<tr><td>

```ts
import Tokenistt from "@tokenistt/sdk";

const client = new Tokenistt({
  attribution: {            // → x-tokenistt-* headers
    team: "platform",
    repo: "acme/api",
    feature: "search",
  },
  budget: { softLimit: 10, hardLimit: 25 },
  throwOnBudgetExceeded: true,
});

client.on("usage", (e) =>
  console.log(`$${e.cumulativeCost.toFixed(4)} so far`));
client.on("budget:warning", (e) => console.warn(e));

const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello" }],
});
```

</td><td>

```python
from tokenistt import OpenAI

client = OpenAI(
    attribution={           # → x-tokenistt-* headers
        "team": "platform",
        "repo": "acme/api",
        "feature": "search",
    },
    budget={"softLimit": 10, "hardLimit": 25},
    throw_on_budget_exceeded=True,
)

client.on("usage", lambda e:
    print(f"${e.cumulative_cost:.4f} so far"))

res = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello"}],
)
```

</td></tr>
</table>

`client.usage()` returns what your key has spent (today, this month, top models, budget headroom). Streaming, `cache=True` (serve identical requests at zero cost), `compress=True`, an async client (`AsyncOpenAI`), typed errors
(`AuthenticationError`, `RateLimitError`, `BudgetExceededError` …) and per-request cost events are included.
Full option lists: [`packages/sdk-ts/README.md`](packages/sdk-ts/README.md) · [`packages/sdk-python/README.md`](packages/sdk-python/README.md).

### Test them

```bash
npm test -w packages/sdk-ts                      # mocked unit smoke test
PYTHONUTF8=1 python packages/sdk-python/tests/smoke.py

# against a REAL running gateway (uses the offline mock model, no provider keys needed)
export TOKENISTT_BASE_URL=http://localhost:3000/v1 TOKENISTT_API_KEY=tktt_live_...
npm run test:live -w packages/sdk-ts
python packages/sdk-python/tests/live.py
```

The gateway's end-to-end suite (`npm run test:e2e -w apps/gateway`) also runs both live tests, so CI exercises the SDKs
against a real gateway on every PR.

---

## 🧑‍💻 Editors & AI agents

Anything that accepts an OpenAI base URL works — **Continue, Cline, the OpenAI SDKs, LangChain**, … — and every request
shows up in **Request history** with its cost.

```yaml
# VS Code · Continue  (~/.continue/config.yaml)
models:
  - name: Tokenistt · gpt-4o
    provider: openai
    model: gpt-4o
    apiBase: http://localhost:3000/v1
    apiKey: tktt_live_...
```

| Tool | Setup |
|---|---|
| **Cline** (VS Code) | API Provider → *OpenAI Compatible* → Base URL `http://localhost:3000/v1`, your key |
| **Continue** (VS Code / JetBrains) | the YAML above |
| **Cursor** | override the OpenAI base URL — Cursor calls from its own servers, so the gateway must be reachable over **public HTTPS** |
| **Claude Desktop / Cursor / Cline / Claude Code (MCP)** | ask your assistant about live spend, budgets and prices. A separate process your client launches (build once, add to its MCP config); needs the stack running — see [User guide §10](docs/GUIDE.md#10-agents-and-editors-mcp) and [`apps/mcp-server`](apps/mcp-server/README.md) |

Attribute spend to teams, repos and tickets with `x-tokenistt-team`, `-project`, `-repo`, `-ticket`, `-feature`, `-customer` headers.
Step-by-step guide: **[docs/CONNECT.md](docs/CONNECT.md)** · everything else: **[docs/GUIDE.md](docs/GUIDE.md)**.

### VS Code extension — usage inside the editor

[`apps/vscode-extension`](apps/vscode-extension/README.md) puts **spend today, budget %, top models and recent requests** in the status bar and a sidebar,
and warns you as a key approaches its cap. It uses your own API key (stored in VS Code's secret storage) against `GET /v1/usage/me`.

```bash
npm run package -w apps/vscode-extension && code --install-extension apps/vscode-extension/tokenistt-vscode-0.1.0.vsix
```

Then run **Tokenistt: Set API Key**. (Not on the Marketplace yet — install the `.vsix`.)

---

## ✨ What it does

| | |
|---|---|
| 💸 **Cost visibility** | Every request is priced (input, output, cache, reasoning tokens) from a versioned catalog. Unknown models report `COST_UNAVAILABLE` and `$0.00` — prices are never invented. |
| 🛡️ **Budgets** | Organization / team / project / key budgets, each measured against *its own* spend. Modes: `alert_only`, `auto_throttle`, `hard_cap`. Deduplicated alerts to Slack/webhook/email. |
| ⚖️ **Governance** | Policies can `allow`, `block`, `force_model`, or `require_approval`. Held requests create an approval an admin approves or denies; the caller retries and passes. |
| 🔀 **Routing** | Opt-in rules choose `cheapest`, `fastest`, `policy` or `fallback` targets, with a dry-run simulator. Provider errors fail over; a circuit breaker stops hammering a dead provider. Applies to streamed requests too. |
| 🔑 **BYOK** | Provider keys stored encrypted (AES-256-GCM, per-org key) with priorities. A rate-limited or rejected key falls through to the next key, then the next provider. |
| 🏷️ **Attribution** | Break spend down by team, project, repo, ticket, sprint, feature, customer, employee — joined to names pulled from your tools. |
| 🔌 **Connectors** | GitHub, Jira, Slack, Linear, Google Analytics 4, Salesforce, CI/CD deployments and signed custom webhooks. |
| 📜 **Audit** | Append-only `audit_log` (admin actions) and `policy_audit_log` (policy, budget and routing decisions). The database rejects `UPDATE`/`DELETE`. |
| 🧱 **Reliability** | Event writes never block the request. If Postgres is down, events queue to disk and replay on recovery. Enforcement fails open on internal errors. |

**Providers:** OpenAI · Anthropic · Azure OpenAI · AWS Bedrock · Groq · Together AI · Google Gemini · Ollama · and an offline `mock:` provider.

---

### 🔒 Enforcement — making the gateway the only way in

A gateway can only govern traffic that reaches it, so enforcement has two halves:

1. **Rules the gateway applies to every request** (Governance → Policies, or `POST /v1/admin/policies`):

   ```jsonc
   // reject any request that doesn't say which team and repo it is for
   { "name": "Attribution required", "conditions": { "missing_attribution": ["team", "repo"] },
     "actions": { "effect": "block", "message": "Send x-tokenistt-team and x-tokenistt-repo." } }

   // model allow-list: block anything not on the list
   { "name": "Approved models only", "conditions": { "model_not_in": ["gpt-4o-mini", "claude-3-haiku"] },
     "actions": { "effect": "block", "message": "Model not approved." } }
   ```

   Combine with budgets in `hard_cap` mode, approvals (`require_approval`) and per-key caps. Revoke a key and it stops working immediately.
2. **Take away the alternative.** Keep provider keys only in the gateway (**Providers & Keys** / `.env`) so developers have nothing to call providers with
   directly, and block provider domains (`api.openai.com`, `api.anthropic.com` …) at your network egress or proxy. Tokenistt cannot do this part for you.

## 🏗️ Architecture

```mermaid
flowchart LR
    App["Your app / editor / agent<br/>(OpenAI SDK, Continue, Cline, Tokenistt SDK)"] -->|OpenAI-compatible API| GW
    subgraph GW["Gateway · Node + TypeScript"]
      direction TB
      A[Auth] --> P[Policy] --> B[Budget] --> R[Routing] --> K[BYOK key] --> X[Provider adapter]
    end
    X --> OAI[OpenAI] & ANT[Anthropic] & MORE[Groq · Gemini · Together · Bedrock · Azure · Ollama]
    GW -->|async, fail-open| DB[(Postgres)]
    GW <--> RD[(Redis)]
    DB --> DASH["Dashboard · Next.js"]
    DASH -->|session-checked proxy| GW
    MCP["MCP server"] --> DASH
```

```
apps/
  gateway/        Express proxy, policy/budget/routing engines, management API, connectors
  dashboard/      Next.js 15 + React 19 (talks to the gateway through a session-checked proxy)
  mcp-server/     MCP tools: spend, budgets, anomalies, price estimates, model comparison
packages/
  db/             Postgres schema, migration runner, demo seed
  sdk-ts/         @tokenistt/sdk — OpenAI-compatible TypeScript client
  sdk-python/     tokenistt — OpenAI-compatible Python client
  analytics/  credential-manager/  shadow-ai-scanner/  finops-middleware/
infra/            Dockerfiles, dev compose, Grafana provisioning
scripts/          setup.mjs — generates .env
```

Design rules the code follows: events are insert-only · prices are versioned · enforcement fails open on internal errors ·
logging never blocks the request path · provider differences live in adapters.

### Configuration

| Variable | Needed | Purpose |
|---|---|---|
| `AUTH_MODE` | – | `open` (default, no login) or `jwt` (sign-in required) |
| `DATABASE_URL` | yes | Postgres |
| `REDIS_URL` | recommended | Shared rate limits and atomic budget reservation. `REDIS_REQUIRED=true` refuses to start without it |
| `ADMIN_SECRET` · `MASTER_KEY` · `ENCRYPTION_KEY` · `JWT_SECRET` | yes | Generated for you by `node scripts/setup.mjs` |
| `OPENAI_API_KEY` `ANTHROPIC_API_KEY` `GROQ_API_KEY` `GEMINI_API_KEY` `TOGETHER_API_KEY` | optional | Gateway-level provider keys (or use per-org BYOK) |
| `OLLAMA_BASE_URL` | optional | Enables Ollama (no key needed) |
| `MOCK_PROVIDER=1` | optional | Offline `mock:` provider (on in the default `.env`) |
| `PUBLIC_GATEWAY_URL` | optional | URL shown in the dashboard's setup snippets |
| `CORS_ORIGINS` · `METRICS_TOKEN` | optional | Browser origins; bearer token for `/metrics` |
| `SLACK_WEBHOOK_URL` · `SMTP_URL` + `ALERT_EMAIL_TO` | optional | Where alerts and approval requests go |

---

## 🧰 Using the API

<details>
<summary><b>Management API, budgets, policies, routing, BYOK</b> — click to expand</summary>

Authenticate with `X-Admin-Secret` (operator; pass `organization_id`) or a dashboard session JWT. Every mutation is written to the audit log.
The complete list is in the OpenAPI document at `/v1/openapi.json`.

```bash
GW=http://localhost:3000; ADMIN=<ADMIN_SECRET from .env>

# create an API key (the token is shown once)
curl -s -X POST "$GW/v1/admin/keys?organization_id=1" -H "x-admin-secret: $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"my-app","budgetCapUsd":50}'

# budget: cap one team at $300/month, hard stop
curl -X POST $GW/v1/admin/budgets -H "x-admin-secret: $ADMIN" -H 'content-type: application/json' \
  -d '{"organization_id":1,"scope_type":"team","scope_id":4,"cap_usd":300,"enforcement_mode":"hard_cap"}'

# policy: hold anything mentioning deploy-prod for approval → 403 approval_required until approved
curl -X POST $GW/v1/admin/policies … \
  -d '{"name":"Prod deploys","conditions":{"prompt_keyword":"deploy-prod"},"actions":{"effect":"require_approval"}}'

# routing: cheapest target first, fail over to the rest
curl -X POST $GW/v1/admin/routing-rules … \
  -d '{"name":"cheap summaries","strategy":"cheapest","match":{"model":"summar"},
       "targets":[{"provider":"openai","model":"gpt-4o-mini"},{"provider":"groq","model":"llama-3.3-70b-versatile"}]}'

# BYOK: add provider keys (lowest priority number is tried first; secrets are write-only)
curl -X POST $GW/v1/admin/provider-keys … -d '{"provider":"openai","api_key":"sk-…","priority":1}'
```

| Permission | owner | admin | finance | developer | viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| read spend, budgets, policies | ✔ | ✔ | ✔ | ✔ | ✔ |
| write budgets | ✔ | ✔ | ✔ | | |
| write policies / routing / keys | ✔ | ✔ | | ✔ | |
| decide approvals, export reports, read audit | ✔ | ✔ | ✔ | | |
| manage connectors | ✔ | ✔ | | | |

</details>

<details>
<summary><b>Request headers and other endpoints</b></summary>

| Header | Effect |
|---|---|
| `x-provider` | Force a provider |
| `x-tokenistt-team` / `-project` | Attribute to a team/project (by slug) so their budgets apply |
| `x-tokenistt-repo` `-ticket` `-sprint` `-feature` `-customer` `-employee` `-environment` | Free-form attribution |
| `x-tokenistt-cache: true` | Serve identical (temperature 0) requests from cache at zero cost (`always` ignores temperature) |
| `x-tokenistt-compress: true` | Collapse redundant whitespace and drop duplicate consecutive messages |

Also: `POST /v1/batch/chat/completions` (up to 20 requests through the full pipeline), `GET /v1/logs` (your key's history),
`GET /v1/models`, `GET /health`, `GET /metrics`. Streaming (`"stream": true`) is supported on every provider.

</details>

<details>
<summary><b>Connectors</b></summary>

```bash
curl -X POST $GW/v1/admin/connectors … -d '{"type":"github","name":"acme-gh","config":{"token":"ghp_…","org":"acme"}}'
curl -X POST $GW/v1/admin/connectors/<id>/sync …
```

Credentials are verified on creation, stored encrypted and never returned. Synced repos, tickets, sprints, customers and people
become names in the attribution view. Push-based connectors (CI/CD, custom webhook) receive signed payloads at
`POST /v1/webhooks/connectors/<id>`. Outbound URLs are SSRF-guarded.

</details>

### The dashboard

**Overview · Usage · Request history · Alerts · Shadow AI · Budgets · Governance · Approvals · Providers & Keys · API keys ·
Routing · Connectors · Audit log · Cost attribution · Cost centers · Chargebacks · Unit economics · Reconciliation ·
Forecasting · Model comparison · Team · Settings.** In-app docs live at `/docs`.
ROI, Board reports, Benchmark and Simulator are hidden unless `NEXT_PUBLIC_EXPERIMENTAL=1`.

---

## 🛠️ Development

```bash
npm install
npm run dev:deps && npm run migrate        # Postgres :5433 + Redis :6380, schema
npm run typecheck && npm run build
npm test                                   # unit + integration (needs DATABASE_URL)
npm run test:e2e -w apps/gateway           # boots the gateway, drives the full pipeline and both SDKs over HTTP
```

Run the services from source:

```bash
export DATABASE_URL=postgres://tokenistt:tokenistt@localhost:5433/tokenistt REDIS_URL=redis://localhost:6380
# terminal 1 — gateway :3000
cd apps/gateway && MOCK_PROVIDER=1 ADMIN_SECRET=dev-admin-secret-0123456789abcdef MASTER_KEY=dev-master-key-0123456789abcdef0123 \
  JWT_SECRET=dev-jwt-secret-0123456789abcdef0123456789abcd npm run dev
# terminal 2 — dashboard :3001
cd apps/dashboard && AUTH_MODE=open OPEN_ORG_ID=1 ADMIN_SECRET=dev-admin-secret-0123456789abcdef GATEWAY_URL=http://localhost:3000 \
  DATABASE_URL=$DATABASE_URL npx next dev -p 3001
```

CI (`.github/workflows/ci.yml`) runs typecheck, build, tests, SDK smoke tests and the end-to-end suite on Node 20 against real
Postgres and Redis. See [CONTRIBUTING.md](CONTRIBUTING.md).

## ✅ What works today

Verified by the test suites and the end-to-end script: key issuance, revocation and authentication · cost calculation and
logging · request history · streaming (native and replayed) · response cache · batch · approval policy with approve/retry ·
routing with failover (streamed requests included) · BYOK key failover · budget enforcement and alerts · attribution joins ·
audit trail · CSV export · RBAC and tenant isolation of the management API · connector sync against fixture servers (all
eight types) · SSRF and signature checks · both SDKs against a live gateway.

## ⚠️ Known gaps

Stated plainly so nobody is surprised:

- **Connectors are tested against fixture servers, not the live services** (no credentials were available). Field names follow each vendor's public API docs; expect small fixes on first real use.
- **Some older dashboard pages** (Usage, Budgets, Governance, Providers, Team, Forecasting …) predate the management API and read Postgres directly. Pages for routing, model comparison, API keys, request history, alerts, audit, approvals and connectors use the gateway API.
- **The VS Code extension is a `.vsix` build, not on the Marketplace**, and has been type-checked and unit-tested but not yet run by hand in an Extension Development Host. Only gateway traffic is counted.
- **SDKs are not on npm/PyPI until a release is tagged** (workflow included; needs `NPM_TOKEN` / `PYPI_API_TOKEN` secrets).
- **Prices** for Groq, Together and Gemini are published list prices added to the catalog — verify them, they change. Models without a price report `COST_UNAVAILABLE`.
- **Not built yet:** SSO (OIDC/SAML), Postgres row-level security, pluggable secrets managers, a Redis-Streams queue for multi-instance deployments, request replay, an `@tokenistt/cli`, and a dual ESM/CJS SDK build.
- Single Postgres instance; no multi-region story.

---

## 👥 Authors

Started and built by the Tokenistt founders:

<table>
  <tr>
    <td align="center" width="200">
      <a href="https://github.com/Aryan-theccool">
        <img src="https://avatars.githubusercontent.com/u/146411259?v=4&s=120" width="100" height="100" alt="Aryan Singh Bhadoria"><br>
        <sub><b>Aryan Singh Bhadoria</b></sub>
      </a><br>
      <sub>Co-founder · CEO<br><a href="https://github.com/Aryan-theccool">@Aryan-theccool</a></sub>
    </td>
    <td align="center" width="200">
      <a href="https://github.com/A-kki">
        <img src="https://avatars.githubusercontent.com/u/206406296?v=4&s=120" width="100" height="100" alt="Akshay Khanna"><br>
        <sub><b>Akshay Khanna</b></sub>
      </a><br>
      <sub>Co-founder · CTO<br><a href="https://github.com/A-kki">@A-kki</a></sub>
    </td>
    <td align="center" width="200">
      <a href="https://github.com/adityatiwari12">
        <img src="https://avatars.githubusercontent.com/u/73302199?v=4&s=120" width="100" height="100" alt="Aditya Tiwari"><br>
        <sub><b>Aditya Tiwari</b></sub>
      </a><br>
      <sub>Co-founder · CPO<br><a href="https://github.com/adityatiwari12">@adityatiwari12</a></sub>
    </td>
  </tr>
</table>

Thanks to everyone on the [contributors graph](https://github.com/Complete-tokenistt/tokenistt/graphs/contributors).

## 📄 License

[Apache-2.0](LICENSE). Security issues: see [SECURITY.md](SECURITY.md).
