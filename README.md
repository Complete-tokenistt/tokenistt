<div align="center">

# Tokenistt

### Open-source AI cost visibility and governance for growing teams

One OpenAI-compatible gateway in front of every AI provider you use — with spend tracking, budgets,
policies, approvals, cost-aware routing and an audit trail. Self-hosted. Apache-2.0.

[![CI](https://github.com/Complete-tokenistt/tokenistt/actions/workflows/ci.yml/badge.svg)](https://github.com/Complete-tokenistt/tokenistt/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

> **Status: early.** The core pipeline is built and tested end to end (see [What works today](#what-works-today)
> and [Known gaps](#known-gaps)). Tokenistt is pre-traction software from a three-person team — there are no
> customers, certifications or benchmarks to point at, and this README does not claim any.

---

## What it does

Point your apps at Tokenistt instead of the provider. Every request flows through one pipeline:

```
your app ─▶ auth ─▶ workspace/team/project ─▶ policies ─▶ budgets ─▶ routing ─▶ BYOK key ─▶ provider
                                                  │            │          │          │
                                           approval flow   alerts    rules +     key failover
                                                                      failover
          ◀── streaming passthrough ◀── cost calculator ◀── response
                                              │
                          async event logger (fail-open, file fallback) ─▶ Postgres ─▶ dashboard
```

| Capability | How it behaves |
|---|---|
| **Cost visibility** | Every request is priced (input, output, cache, reasoning tokens) from a versioned price catalog. Unknown models report `COST_UNAVAILABLE` and `$0.00` — prices are never invented. |
| **Budgets** | Organization / team / project / virtual-key budgets, each measured only against *its own* spend. Modes: `alert_only`, `auto_throttle`, `hard_cap`. Alerts are deduplicated and sent to Slack/webhook/email. |
| **Governance** | Policies can `allow`, `block`, `force_model`, or `require_approval`. Held requests create an approval that an admin approves or denies; the caller retries and passes. |
| **Routing** | Opt-in rules choose `cheapest`, `fastest`, `policy` or `fallback` targets. Provider errors fail over to the next candidate; a per-provider circuit breaker stops hammering a dead provider. |
| **BYOK** | Provider keys are stored encrypted (AES-256-GCM, per-org key) with priorities. A rate-limited or rejected key falls through to the next key, then the next provider. |
| **Attribution** | Send `x-tokenistt-{team,project,repo,ticket,sprint,feature,customer,employee}` headers; spend is broken down by those dimensions and joined to names pulled from your tools. |
| **Connectors** | GitHub, Jira, Slack, Linear, Google Analytics 4, Salesforce, CI/CD deployments and signed custom webhooks. |
| **Audit** | Append-only `audit_log` (admin actions) and `policy_audit_log` (policy, budget and routing decisions). The database rejects `UPDATE`/`DELETE`. |
| **Reliability** | Event writes never block the request. If Postgres is down, events queue to disk and replay on recovery. Enforcement fails open on internal errors. |

**Providers:** OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Groq, Together AI, Google Gemini, Ollama (and an offline `mock:` provider for trying things out).

---

## Quick start

### Option A — Docker Compose (the whole stack)

```bash
git clone https://github.com/Complete-tokenistt/tokenistt.git && cd tokenistt
cp .env.example .env
# fill in the five secrets — each:  openssl rand -hex 32
#   POSTGRES_PASSWORD  ADMIN_SECRET  MASTER_KEY  ENCRYPTION_KEY  JWT_SECRET
# optional: set MOCK_PROVIDER=1 to try it without real provider keys

docker compose up --build
```

| Service | URL |
|---|---|
| Gateway (OpenAI-compatible API) | http://localhost:3000 |
| Dashboard | http://localhost:3001 |
| API docs (OpenAPI 3.1) | http://localhost:3000/v1/openapi.json |

Host ports are configurable (`GATEWAY_PORT`, `DASHBOARD_PORT`, `POSTGRES_PORT`, `REDIS_PORT`) if something local already uses them.
Migrations run automatically in a one-shot `migrate` container.

### Option B — local development

Requires Node 20+ and Docker (for Postgres and Redis only).

```bash
npm install
npm run dev:deps          # Postgres on :5433 and Redis on :6380 (avoids clashing with local installs)

export DATABASE_URL=postgres://tokenistt:tokenistt@localhost:5433/tokenistt
export REDIS_URL=redis://localhost:6380
npm run migrate                           # apply the schema
node packages/db/seed-demo.mjs            # optional: a demo org with 14 days of synthetic traffic

# terminal 1 — gateway on :3100 (MOCK_PROVIDER adds the offline "mock:" provider)
cd apps/gateway
MOCK_PROVIDER=1 PORT=3100 ADMIN_SECRET=dev-admin-secret-0123456789abcdef MASTER_KEY=dev-master-key-0123456789abcdef0123 \
  JWT_SECRET=dev-jwt-secret-0123456789abcdef0123456789abcd npm run dev

# terminal 2 — dashboard on :3101
cd apps/dashboard
JWT_SECRET=dev-jwt-secret-0123456789abcdef0123456789abcd STRICT_AUTH=true GATEWAY_URL=http://localhost:3100 \
  ADMIN_SECRET=dev-admin-secret-0123456789abcdef npx next dev -p 3101
```

The two `JWT_SECRET` values must match: the dashboard signs sessions, and the gateway verifies them.

The seed prints three logins (password `demo-password-123`) and two API keys:

| Login | Role | Can |
|---|---|---|
| `owner@demo.test` | owner | everything |
| `finance@demo.test` | finance | budgets, approvals, reports, audit |
| `viewer@demo.test` | viewer | read only |

---

## Using it

### 1. Create a key and send a request

```bash
ADMIN=dev-admin-secret-0123456789abcdef; ORG=<organization id>

# create a virtual key (the token is shown once)
curl -s -X POST "http://localhost:3100/v1/admin/keys?organization_id=$ORG" \
  -H "x-admin-secret: $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"my-app","budgetCapUsd":50}'

# use it exactly like the OpenAI API
curl -s http://localhost:3100/v1/chat/completions \
  -H "authorization: Bearer tktt_live_…" -H 'content-type: application/json' \
  -H 'x-tokenistt-feature: search' -H 'x-tokenistt-repo: acme/api' \
  -d '{"model":"mock:echo","messages":[{"role":"user","content":"hello"}]}'
```

Cost comes back in the `x-tokenistt-cost` header and in `_tokenistt` in the body. With the TypeScript SDK:

```ts
import Tokenistt from '@tokenistt/sdk';
const client = new Tokenistt({
  apiKey: process.env.TOKENISTT_KEY,
  baseURL: 'http://localhost:3000/v1',
  defaultHeaders: { 'x-tokenistt-feature': 'search' },   // attribution on every call
});
const res = await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
```

### 2. Request headers

| Header | Effect |
|---|---|
| `x-provider` | Force a provider |
| `x-tokenistt-team` / `-project` | Attribute to a team/project (by slug) so team/project budgets apply |
| `x-tokenistt-repo` `-ticket` `-sprint` `-feature` `-customer` `-employee` `-environment` | Free-form attribution |
| `x-tokenistt-cache: true` | Serve identical (temperature 0) requests from cache at zero cost (`always` ignores temperature) |
| `x-tokenistt-compress: true` | Collapse redundant whitespace and drop duplicate consecutive messages |

Other endpoints: `POST /v1/batch/chat/completions` (up to 20 requests through the full pipeline), `GET /v1/logs` (your key's history), `GET /v1/models`, `GET /health`, `GET /metrics`.

### 3. Management API (`/v1/admin/*`)

Authenticate with `X-Admin-Secret` (operator; pass `organization_id`) or a dashboard session JWT as `Authorization: Bearer …`
(locked to the user's organization and limited by role). Every mutation is written to the audit log.

```bash
# budgets: cap one team at $300/month, hard stop
curl -X POST $GW/v1/admin/budgets -H "x-admin-secret: $ADMIN" -H 'content-type: application/json' \
  -d '{"organization_id":1,"scope_type":"team","scope_id":4,"cap_usd":300,"enforcement_mode":"hard_cap"}'

# policy: hold anything that mentions deploy-prod for approval
curl -X POST $GW/v1/admin/policies … \
  -d '{"name":"Prod deploys","conditions":{"prompt_keyword":"deploy-prod"},"actions":{"effect":"require_approval"}}'
#   → the request gets 403 {"error":{"code":"approval_required","approval_id":"…"}}
curl -X POST $GW/v1/admin/approvals/<approval_id>/approve …     # then the caller retries and it passes

# routing: try the cheapest target first, fail over to the rest
curl -X POST $GW/v1/admin/routing-rules … \
  -d '{"name":"cheap summaries","strategy":"cheapest","match":{"model":"summar"},
       "targets":[{"provider":"openai","model":"gpt-4o-mini"},{"provider":"groq","model":"llama-3.3-70b"}]}'

# BYOK: add provider keys (lowest priority number is tried first; secrets are write-only)
curl -X POST $GW/v1/admin/provider-keys … -d '{"provider":"openai","api_key":"sk-…","priority":1}'
```

The full list — budgets, policies, routing rules, alerts, audit, approvals, workspaces, teams, projects, provider keys,
connectors, attribution, request history, CSV export — is in the OpenAPI document at `/v1/openapi.json`.

| Permission | owner | admin | finance | developer | viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| read spend, budgets, policies | ✔ | ✔ | ✔ | ✔ | ✔ |
| write budgets | ✔ | ✔ | ✔ | | |
| write policies / routing / keys | ✔ | ✔ | | ✔ | |
| decide approvals, export reports, read audit | ✔ | ✔ | ✔ | | |
| manage connectors | ✔ | ✔ | | | |

### 4. Connectors

```bash
curl -X POST $GW/v1/admin/connectors … -d '{"type":"github","name":"acme-gh","config":{"token":"ghp_…","org":"acme"}}'
curl -X POST $GW/v1/admin/connectors/<id>/sync …
```

Credentials are verified when the connector is created, stored encrypted, and never returned. Synced repos, tickets, sprints,
customers and people become names in the attribution view (`GET /v1/admin/attribution`). Push-based connectors (CI/CD, custom
webhook) receive signed payloads at `POST /v1/webhooks/connectors/<id>`. Outbound URLs are SSRF-guarded.

### 5. Dashboard

Overview · Usage · **Request history** · **Alerts** · Shadow AI · Budgets · Governance · **Approvals** · Providers & Keys ·
Routing · **Connectors** · **Audit log** · Cost attribution · Cost centers · Chargebacks · Unit economics · Reconciliation ·
Forecasting · Model comparison · Team · Settings. (Bold pages read the gateway management API; see [Known gaps](#known-gaps).)
ROI, Board reports, Benchmark and Simulator are hidden unless `NEXT_PUBLIC_EXPERIMENTAL=1`.

---

## Architecture

```
apps/
  gateway/        Node.js + TypeScript (Express). Proxy, policy/budget/routing engines, management API, connectors
  dashboard/      Next.js 15 + React 19 dashboard (talks to the gateway through a session-checked proxy)
  mcp-server/     MCP tools for AI agents (spend summary, budget status, cost estimate, routing …)
packages/
  db/             Postgres schema + migration runner + demo seed
  sdk-ts/         @tokenistt/sdk — OpenAI-compatible TypeScript client
  sdk-python/     Python client
  analytics/      Optional ClickHouse/Kafka path (off by default)
  credential-manager/  shadow-ai-scanner/  finops-middleware/
infra/            Dockerfiles, dev compose, Grafana provisioning
```

Design rules the code follows: events are insert-only; prices are versioned; enforcement fails open on internal errors;
logging never blocks the request path; provider differences live in adapters.

### Configuration

| Variable | Needed | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres. Unset = "open mode" for local experiments (no auth, no logging) |
| `REDIS_URL` | recommended | Shared rate limits and atomic budget reservation. `REDIS_REQUIRED=true` refuses to start without it |
| `ADMIN_SECRET` | production | Operator access to `/v1/admin/*` |
| `MASTER_KEY`, `ENCRYPTION_KEY` | production | Encrypt BYOK provider keys and connector credentials |
| `JWT_SECRET` | production | Dashboard sessions; identical in dashboard and gateway |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `TOGETHER_API_KEY` | optional | Gateway-level provider keys (or use per-org BYOK) |
| `OLLAMA_BASE_URL` | optional | Enables Ollama (no key needed) |
| `CORS_ORIGINS` | optional | Allowed browser origins; production default is none |
| `METRICS_TOKEN` | optional | Bearer token for `/metrics` (otherwise private networks only in production) |
| `SLACK_WEBHOOK_URL`, `SMTP_URL` + `ALERT_EMAIL_TO` | optional | Where alerts and approval requests go |
| `MOCK_PROVIDER=1` | optional | Offline `mock:` provider |

---

## Development

```bash
npm run dev:deps && npm run migrate          # Postgres + Redis, schema
npm run typecheck && npm run build           # everything
npm test                                     # unit + integration (needs the database above)
npm run test:e2e -w apps/gateway             # boots the gateway and drives the full pipeline over HTTP
```

CI (`.github/workflows/ci.yml`) runs the same steps on Node 20 against real Postgres and Redis. See [CONTRIBUTING.md](CONTRIBUTING.md).

## What works today

Verified by the test suites and the end-to-end script: key issuance and authentication, cost calculation and logging,
request history, response cache, batch, approval policy with approve/retry, routing with provider failover, BYOK key
failover, budget enforcement and alerts, attribution joins, audit trail, CSV export, RBAC and tenant isolation of the
management API, connector sync against fixture servers (all eight types), SSRF and signature checks.

## Known gaps

Stated plainly so nobody is surprised:

- **Connectors are tested against fixture servers, not the live services** (no credentials were available). Field names follow each vendor's public API docs; expect small fixes on first real use.
- **Older dashboard pages** (Overview, Usage, Budgets, Governance, Routing, Providers, Team, Forecasting …) predate the management API: they read Postgres directly and fall back to sample data when it is unavailable. The pages marked bold above use the gateway API. Unifying them is planned.
- **Not built yet:** SSO (OIDC/SAML), Postgres row-level security, pluggable secrets managers (AWS/Vault/Azure), Redis-Streams event queue for multi-instance deployments, request replay, per-provider latency SLO alerts, an `@tokenistt/cli`, and a dual ESM/CJS SDK build.
- Prices exist for OpenAI, Anthropic and a few others; Groq, Together and Gemini models report `COST_UNAVAILABLE` until a price is added to the catalog.
- Single Postgres instance; no multi-region story.

---

## Authors

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

## License

[Apache-2.0](LICENSE). Security issues: see [SECURITY.md](SECURITY.md).
