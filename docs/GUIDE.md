# Using Tokenistt

A task-oriented guide: from an empty machine to tracked, budgeted and governed AI traffic. Everything here runs on your own
infrastructure. For the one-screen version see the [README](../README.md); for the full API see
`GET /v1/openapi.json` and [API.md](API.md).

**Contents**
[1. How it fits together](#1-how-it-fits-together) ·
[2. Install and first request](#2-install-and-first-request) ·
[3. Send real traffic](#3-send-real-traffic) ·
[4. See what you spend](#4-see-what-you-spend) ·
[5. Budgets](#5-budgets) ·
[6. Policies and approvals](#6-policies-and-approvals) ·
[7. Routing and failover](#7-routing-and-failover) ·
[8. Provider keys (BYOK)](#8-provider-keys-byok) ·
[9. Attribution and connectors](#9-attribution-and-connectors) ·
[10. Agents and editors (MCP)](#10-agents-and-editors-mcp) ·
[11. Going beyond localhost](#11-going-beyond-localhost) ·
[12. Troubleshooting](#12-troubleshooting)

---

## 1. How it fits together

Your apps, editors and agents talk to **one OpenAI-compatible endpoint** (the gateway) instead of to each provider.
Every request passes through the same pipeline before it reaches a provider:

```
your app ──▶ auth ─▶ policy ─▶ budget ─▶ routing ─▶ provider key ─▶ provider
                                                                      │
                  cost is calculated and the request is logged ◀──────┘
```

| Piece | Where | What you use it for |
|---|---|---|
| **Gateway** | `http://localhost:3000/v1` | The API your code calls. Also hosts the management API (`/v1/admin/*`). |
| **Dashboard** | `http://localhost:3001` | See spend, set budgets and policies, manage keys. |
| **Virtual key** (`tktt_live_…`) | Dashboard → **API keys** | What your code authenticates with. One per app, laptop or team. Revocable instantly. |
| **Provider key** | `.env` or dashboard → **Providers & Keys** | Your real OpenAI / Anthropic / … key. Stays inside the gateway; developers never see it. |
| **Postgres** | container | Stores everything. Required. |
| **Redis** | container | Shared rate limits and budget reservation. Recommended; the gateway still works without it. |

Two defaults worth knowing before you start:

- **Enforcement is soft by default.** Budgets alert but do not block unless you choose `hard_cap`. If the gateway hits an
  internal error while checking a policy or budget, the request goes through rather than failing.
- **Unknown prices are reported, not guessed.** A model with no catalog price is logged with cost `$0.00` and status
  `COST_UNAVAILABLE`.

## 2. Install and first request

You need **Docker** and **Node 20+** (Node only runs the setup script).

```bash
git clone https://github.com/Complete-tokenistt/tokenistt.git && cd tokenistt
node scripts/setup.mjs            # writes .env with fresh secrets; never overwrites an existing .env
docker compose up --build -d      # postgres, redis, migrations, gateway, dashboard
docker compose ps                 # all services should be running / healthy
```

Optional: load clearly-labelled synthetic sample data so the dashboard has something to show.

```bash
docker compose --profile demo up seed
```

Open <http://localhost:3001>. The first visit asks you to create the owner account; the setup token is `ADMIN_SECRET`
from your `.env`. After that, sign in with that email and password. (`AUTH_MODE=open` removes the login entirely: only for
a throwaway install on your own machine.) To let other machines in, see [section 11](#11-going-beyond-localhost).

**Create a key and make a request.** Dashboard → **API keys** → create one (the token is shown once), or use the
**Get started** page, which does this and sends a test request for you. Then:

```bash
export TOKENISTT_KEY=tktt_live_...

curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $TOKENISTT_KEY" -H 'content-type: application/json' \
  -d '{"model":"mock:echo","messages":[{"role":"user","content":"hello"}]}'
```

`mock:echo` is an offline model served by the built-in `mock:` provider (`MOCK_PROVIDER=1`, on in the generated `.env`), so
this works with no provider keys. The response carries its cost in the `x-tokenistt-cost` header and in `_tokenistt` in the
body, and the request appears under **Request history**.

## 3. Send real traffic

1. **Add a provider key.** Either put it in `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`,
   `GEMINI_API_KEY`, `TOGETHER_API_KEY`) and restart with `docker compose up -d`, or store it per organization under
   **Providers & Keys** (encrypted, write-only — see [section 8](#8-provider-keys-byok)). Ollama needs only `OLLAMA_BASE_URL`.
2. **Point your client at the gateway.** Change two settings — base URL and API key:

   ```python
   from openai import OpenAI
   client = OpenAI(base_url="http://localhost:3000/v1", api_key="tktt_live_...")
   client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}])
   ```

   Tools that read environment variables: `OPENAI_BASE_URL=http://localhost:3000/v1 OPENAI_API_KEY=$TOKENISTT_KEY`.
3. **Check the model name.** `GET /v1/models` lists what the gateway can reach and whether each model has a price. Use
   `x-provider: <name>` to force a provider.

Streaming (`"stream": true`) works on every provider. Prefer the Tokenistt SDKs if you want budget warnings, retries and
`client.usage()` in your code — see [SDKs in the README](../README.md#-sdks). Editor setup (Continue, Cline, Cursor) is in
[CONNECT.md](CONNECT.md).

## 4. See what you spend

| Page | Answers |
|---|---|
| **Overview** | Is anything wrong? Spend, budget health, alerts. |
| **Request history** | What exactly was sent, by whom, to which model, and what did it cost? |
| **Usage** | Spend over time, by model and provider; CSV export. |
| **Alerts** | Budget thresholds that were crossed. |
| **Model comparison** | Catalog price next to your observed latency, cost and error rate per model. |

From code: `GET /v1/logs` returns the calling key's history, and `GET /v1/usage/me` returns what the key has spent today and
this month, its top models and its budget headroom.

> **Know which pages are live.** Request history, Alerts, Audit, Approvals, Routing, API keys, Model comparison and
> Connectors read through the gateway API. Some older pages (Usage, Budgets, Governance, Providers, Team, Forecasting …) read
> Postgres directly and may show sample data when the database is unreachable. Treat a page with sample data as a symptom of
> a connection problem, not as your numbers. Unifying them is on the [roadmap](ROADMAP.md).

## 5. Budgets

A budget caps spend for one **scope** — `organization`, `team`, `project` or `virtual_key` — and is measured only against
that scope's own spend. Create one in **Budgets**, or:

```bash
GW=http://localhost:3000; ADMIN=<ADMIN_SECRET from .env>
curl -X POST $GW/v1/admin/budgets -H "x-admin-secret: $ADMIN" -H 'content-type: application/json' \
  -d '{"organization_id":1,"scope_type":"team","scope_id":4,"cap_usd":300,"enforcement_mode":"hard_cap"}'
```

| `enforcement_mode` | When the cap is reached |
|---|---|
| `alert_only` | Alerts at the warning (80% by default) and critical (90%) thresholds and at the cap. Traffic is never blocked or slowed. |
| `auto_throttle` | Like `alert_only`, and once the critical threshold is passed each request is delayed (500 ms by default, `BUDGET_THROTTLE_MS`) but still served. It does not block at the cap. |
| `hard_cap` | Requests are rejected with `429 budget_exceeded` once the cap is reached. |

Alerts are deduplicated and go to Slack / webhook / email. Start with `alert_only`, watch a week of real spend, then tighten. Alerts need a destination: set `SLACK_WEBHOOK_URL`
and/or `SMTP_URL` + `ALERT_EMAIL_TO` in `.env`. To attribute requests to a team or project budget, send
`x-tokenistt-team` / `x-tokenistt-project` (by slug).

## 6. Policies and approvals

A policy matches requests by **conditions** and applies an **effect**: `allow`, `block`, `force_model`, or
`require_approval`. Manage them in **Governance & Policies**, or via `POST /v1/admin/policies`.

```jsonc
// reject requests that don't say which team and repo they belong to
{ "name": "Attribution required", "conditions": { "missing_attribution": ["team", "repo"] },
  "actions": { "effect": "block", "message": "Send x-tokenistt-team and x-tokenistt-repo." } }

// model allow-list
{ "name": "Approved models only", "conditions": { "model_not_in": ["gpt-4o-mini", "claude-3-haiku"] },
  "actions": { "effect": "block", "message": "Model not approved." } }

// send a model to a cheaper one
{ "name": "Downgrade", "conditions": { "model": "gpt-4" },
  "actions": { "effect": "force_model", "model": "gpt-4o-mini" } }

// hold risky prompts for a human
{ "name": "Prod deploys", "conditions": { "prompt_keyword": "deploy-prod" },
  "actions": { "effect": "require_approval" } }
```

**How approvals work.** A matching request returns `403 approval_required` with an `approval_id`. An owner, admin or finance
user opens **Approvals** and approves or denies it. Once approved, the caller **retries the same request** and it passes.
Nothing is queued on the caller's behalf, so build the retry into the client.

Every decision is written to the append-only policy audit log (**Audit log**).

## 7. Routing and failover

Routing is opt-in. A rule matches requests and lists ordered **targets**:

```bash
curl -X POST $GW/v1/admin/routing-rules -H "x-admin-secret: $ADMIN" -H 'content-type: application/json' \
  -d '{"organization_id":1,"name":"cheap summaries","strategy":"cheapest","match":{"model":"summar"},
       "targets":[{"provider":"openai","model":"gpt-4o-mini"},{"provider":"groq","model":"llama-3.3-70b-versatile"}]}'
```

Strategies: `cheapest`, `fastest`, `policy`, `fallback`. When a provider errors the request fails over to the next target, and
a per-provider circuit breaker stops sending traffic to one that keeps failing. Use the **Routing** page's simulator (or
`POST /v1/admin/routing-rules/simulate`) to dry-run a rule before it matters.

> `cheapest` can only rank models that have a catalog price. Groq, Together and Gemini models report
> `COST_UNAVAILABLE` until a price is added, so verify prices before relying on cost-based routing across them.

To rehearse failover without a real outage, use the offline models: `mock:fail` returns a 500 and `mock:limited` returns a 429.

## 8. Provider keys (BYOK)

In **Providers & Keys**, add keys per provider with a `priority` (lowest number is tried first). Keys are encrypted with
AES-256-GCM and **never returned by any API** — you can replace or delete one, not read it back. A rate-limited or rejected
key falls through to the next key, then to the next routing target. Gateway-level keys from `.env` are the last fallback.

Keep `MASTER_KEY` and `ENCRYPTION_KEY` safe and stable: they protect stored keys, and changing them makes existing stored
keys unreadable.

## 9. Attribution and connectors

Add headers to any request and spend can be broken down by them in **Cost attribution**, **Cost centers** and
**Chargebacks**:

```
x-tokenistt-team: platform        x-tokenistt-project: copilot
x-tokenistt-repo: acme/api        x-tokenistt-ticket: ENG-1234
x-tokenistt-feature: search       x-tokenistt-customer: acme
x-tokenistt-sprint  x-tokenistt-employee  x-tokenistt-environment
```

Header values are IDs. **Connectors** (GitHub, Jira, Slack, Linear, Google Analytics 4, Salesforce, CI/CD, signed
webhooks) sync names for those IDs, so `ENG-1234` can show up as a ticket title. Add one under **Connectors**; credentials
are verified when you save them, stored encrypted and never shown again. Connectors are only tested against fixture servers
so far — expect small fixes the first time you point one at a real account, and report them.

## 10. Agents and editors (MCP)

`apps/mcp-server` lets MCP clients (Claude Desktop, Cursor, Cline, Claude Code …) ask your running stack about spend,
budgets, anomalies and prices. It is a separate process the client launches; it has no UI of its own. It reads from the
dashboard (port 3001), so the stack must be running.

```bash
npm install && npm run build --workspace=apps/mcp-server
```

Add it to the client's MCP config, with an **absolute** path:

```json
{
  "mcpServers": {
    "tokenistt": {
      "command": "node",
      "args": ["/absolute/path/to/tokenistt/apps/mcp-server/dist/index.js"],
      "env": {
        "TOKENISTT_DASHBOARD_URL": "http://localhost:3001",
        "TOKENISTT_GATEWAY_URL": "http://localhost:3000",
        "TOKENISTT_API_KEY": "tktt_live_..."
      }
    }
  }
}
```

For Claude Code: `claude mcp add tokenistt -- node /absolute/path/to/tokenistt/apps/mcp-server/dist/index.js`.

| Tool | Use it to ask |
|---|---|
| `get_spend_summary` | "What have we spent this month?" |
| `check_budget_status` | "Which budgets are close to their cap?" |
| `estimate_prompt_cost` | "What would 2M input tokens on this model cost?" |
| `detect_anomalies` | "Did anyone spike versus their baseline?" |
| `list_cost_centers`, `get_team_spend` | "Who is spending what?" |
| `compare_models` | "How do these models compare on price and observed latency?" |
| `route_prompt` | Send a prompt via the cheapest priced model within a budget. Needs `TOKENISTT_API_KEY`. |

If the stack is unreachable a tool returns an error that says so; it never substitutes made-up numbers. Verify the
connection with `npm run smoke --workspace=apps/mcp-server` (stack running). Set `TOKENISTT_DASHBOARD_TOKEN` only if the
dashboard runs with `AUTH_MODE=jwt`. The optional `MCP_TRANSPORT=sse` mode has **no authentication** — keep it on a
private network. Full reference: [apps/mcp-server/README.md](../apps/mcp-server/README.md).

The VS Code extension in `apps/vscode-extension` is separate: it shows your own key's spend and budget in the status bar.

## 11. Going beyond localhost

Before anyone else can reach it:

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full operator guide (TLS, backups, upgrades, retention). The short list:

- [ ] Keep `AUTH_MODE=jwt` (the default) so the dashboard requires sign-in. Never combine `AUTH_MODE=open` with `BIND_ADDR=0.0.0.0`.
- [ ] Put HTTPS in front: `docker compose --profile tls up -d` (Caddy) or your own reverse proxy, with `TRUST_PROXY` set. Tokenistt does not terminate TLS.
- [ ] Set `PUBLIC_GATEWAY_URL` so setup snippets show the right address, and `CORS_ORIGINS` to your dashboard origin.
- [ ] Keep `METRICS_TOKEN` secret (it is required and generated by `scripts/setup.mjs`).
- [ ] Back up Postgres **and** `MASTER_KEY`. Postgres is the only store of record and is a single instance, with no replication or multi-region story.
- [ ] Keep `.env` out of version control; it holds your secrets.
- [ ] Remove the `mock:` provider from production if you do not want it (`MOCK_PROVIDER=0`).
- [ ] Take away the alternative: keep provider keys only in the gateway and block provider domains at your network egress.
      A gateway governs only the traffic that reaches it, and Tokenistt cannot enforce the egress half for you.

Not built yet: SSO (OIDC/SAML), Postgres row-level security, pluggable secrets managers, and multi-instance event queueing.
See "Known gaps" in the [README](../README.md).

## 12. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `401 auth_failed` | Key is missing, mistyped or revoked. Tokens are shown once; create a new one. Send it as `Authorization: Bearer tktt_live_…`. |
| `403 policy_violation` | A policy blocked the request. The message is the policy's own; check **Governance & Policies** and **Audit log**. |
| `403 approval_required` | Held for approval. Approve it under **Approvals**, then retry the same request. |
| `429 budget_exceeded` | A `hard_cap` budget in scope is exhausted. Raise the cap, change the mode, or wait for the period to reset. |
| `429 rate_limit_exceeded` | The virtual key's rate limit. Slow down or use another key. |
| Cost shows `$0.00` / `COST_UNAVAILABLE` | The model has no catalog price. Prices are never guessed; add one to the catalog. |
| `provider_error` | The upstream provider rejected or failed the call. The body names the provider and its code. Check the provider key under **Providers & Keys**. |
| Dashboard shows sample data | An older page cannot reach Postgres. Check `docker compose ps` and `docker compose logs dashboard`. |
| Requests succeed but nothing appears | Events are queued to disk if Postgres is down and replay on recovery. Check `docker compose logs gateway` and `GET /health`. |
| Port already in use | Set `GATEWAY_PORT`, `DASHBOARD_PORT`, `POSTGRES_PORT` or `REDIS_PORT` in `.env`, then `docker compose up -d`. |
| Cursor cannot reach `localhost` | Cursor calls models from its own servers. Expose the gateway over public HTTPS. |
| MCP tools return "Could not reach the Tokenistt dashboard" | The stack is not running, or `TOKENISTT_DASHBOARD_URL` is wrong. |
| `route_prompt` fails | `TOKENISTT_API_KEY` is not set in the MCP client's `env` block. |

Useful commands:

```bash
docker compose logs -f gateway          # request pipeline and errors
curl http://localhost:3000/health       # gateway liveness
docker compose down                     # stop, keep data
docker compose down -v                  # stop and DELETE all data (database and Redis volumes)
```

Still stuck? Open an issue with the output of `docker compose ps` and the relevant `docker compose logs` lines — and remove any
keys first. For security problems, see [SECURITY.md](../SECURITY.md) instead of filing a public issue.
