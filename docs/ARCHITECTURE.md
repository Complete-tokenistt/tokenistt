# Tokenistt — Architecture

Tokenistt is a single gateway service in front of one Postgres database, with Redis as an optional accelerator. It is not a distributed system — see `ROADMAP.md` for what would change that.

The migrations in `packages/db/drizzle/*.sql` are the source of truth for the schema; the OpenAPI document at `/v1/openapi.json` is the source of truth for the API. This file explains how the pieces fit together.

## System overview

```
Client app (OpenAI SDK, @tokenistt/sdk, curl)
    │  POST /v1/chat/completions   Authorization: Bearer tktt_live_…
    ▼
┌──────────────────────────────────────────────────────────────┐
│                  Gateway (Node.js + TypeScript, Express)        │
│                                                                   │
│  Auth → workspace/team/project → Policy (+approval hold) →       │
│  Budget → Routing (rules, failover, circuit breaker) →           │
│  BYOK key resolver (priority failover) → Provider adapter →      │
│  Streaming passthrough → Cost calculator →                       │
│  Event logger (async, fail-open to a disk queue)                 │
└──────────────────────────────────────────────────────────────┘
    │                   │                         │
    ▼                   ▼                         ▼
AI providers        Postgres 16               Redis 7 (optional)
(OpenAI, Anthropic, (single instance)         rate limits, key cache,
 Azure, Bedrock,         │                    atomic budget reservation
 Groq, Together,         ▼
 Gemini, Ollama,    Management API  /v1/admin/*  (RBAC)
 mock:)                  │
                         ▼
                   Dashboard (Next.js) ── session-checked proxy ──▶ gateway
```

Other pieces: `apps/mcp-server` (MCP tools for agents, talks to the gateway API), `packages/sdk-ts` and `packages/sdk-python` (OpenAI-compatible clients), `packages/analytics` (optional ClickHouse/Kafka path, off by default).

## Repo layout

| Path | Role |
|---|---|
| `apps/gateway` | Proxy, policy/budget/routing engines, management API, connectors |
| `apps/dashboard` | Next.js 15 / React 19 product frontend |
| `apps/mcp-server` | MCP tools for AI agents |
| `packages/db` | Migrations, migration runner, `schema.ts`, demo seed |
| `packages/sdk-ts`, `packages/sdk-python` | Client SDKs |
| `packages/analytics` | Optional ClickHouse/Kafka path |
| `packages/credential-manager`, `shadow-ai-scanner`, `finops-middleware` | Supporting libraries |
| `infra` | Dockerfiles, dev compose, Grafana provisioning |

## Request pipeline

Implemented in `apps/gateway/src/server.ts` and `apps/gateway/src/services/`:

1. **Auth** — hash the virtual key (`tktt_live_…`), resolve it (Redis cache, Postgres fallback), reject revoked keys.
2. **Resolve scope** — organization, workspace, and `x-tokenistt-team` / `-project` slugs. Free-form attribution headers (`-repo`, `-ticket`, `-sprint`, `-feature`, `-customer`, `-employee`, `-environment`) are captured for later joins.
3. **Policy** — conditions match model, team, environment, prompt keyword, etc. Effects: `allow`, `block`/`deny`, `force_model`, `require_approval`. A held request returns `403 approval_required` with an `approval_id`; once an admin approves, the caller's retry passes.
4. **Budget** — org / team / project / virtual-key scopes, each measured only against its own spend. Modes `alert_only`, `auto_throttle`, `hard_cap`. Spend is reserved atomically (Redis) so concurrent requests can't overshoot. Crossing a threshold writes a deduplicated `budget_alerts` row and notifies Slack / webhook / email.
5. **Routing** — opt-in rules (`cheapest`, `fastest`, `policy`, `fallback`) pick ordered targets. A provider error fails over to the next target; a per-provider circuit breaker stops hammering a dead provider.
6. **BYOK** — decrypt the org's provider keys (AES-256-GCM, priority order). A rate-limited or rejected key falls through to the next key, then the next provider. Gateway-level env keys are the fallback.
7. **Provider adapter** — the only code that knows provider specifics (see below).
8. **Streaming passthrough** — chunks are forwarded unbuffered; usage is taken from the provider's final chunk.
9. **Cost calculator** — prices input, output, cache and reasoning tokens from the versioned catalog; unknown model ⇒ `COST_UNAVAILABLE` and `$0.00`.
10. **Event logger** — fire-and-forget insert into `transactions`. If Postgres is down the event goes to a disk queue (`durableQueue.ts`) and replays on recovery. Never awaited before responding.

Cost is returned in the `x-tokenistt-cost` header and `_tokenistt` in the response body. Optional extras on the same path: response cache (`x-tokenistt-cache`), whitespace compression (`x-tokenistt-compress`), and `POST /v1/batch/chat/completions`.

## Provider adapter interface

The most important abstraction in the codebase. Adapters live in `apps/gateway/src/providers/` (`openai`, `anthropic`, `azure`, `bedrock`, `openaiCompat` for Groq/Together/Gemini/Ollama, `mock`) and implement the interface in `base.ts`. **Nothing outside an adapter may branch on the provider name.** Adding an OpenAI-compatible provider is a registry entry plus a price-catalog entry; a non-compatible one is a new adapter.

## Database

Migrations are numbered SQL files in `packages/db/drizzle/` (`0000_init` … `0011_oss_core`), applied by `npm run migrate`. Never `ALTER TABLE` by hand.

| Concept | Tables |
|---|---|
| Tenancy | `organizations`, `workspaces`, `teams`, `projects`, `users` |
| Customer keys | `virtual_keys` (hashed; prefix kept for display) |
| BYOK | `provider_keys` (encrypted, `priority`, `status`) |
| Request log | `transactions` (partitioned, insert-only; `partitionManager.ts` creates partitions), `hourly_spend` (rollup) |
| Pricing | `model_catalog`, versioned price history |
| Enforcement | `budgets`, `budget_alerts`, `policies`, `routing_rules`, `approval_requests` |
| Audit | `audit_log` (admin actions), `policy_audit_log` (policy/budget/routing decisions) — both reject `UPDATE`/`DELETE` |
| Attribution | `connectors`, `connector_entities`, `connector_sync_runs`, `unit_metrics` |
| Finance | `provider_invoices` (reconciliation), `request_replays` |

## Management API and RBAC

`/v1/admin/*` accepts either `X-Admin-Secret` (operator; pass `organization_id`) or a dashboard session JWT (locked to the user's organization, limited by role). Roles: `owner`, `admin`, `finance`, `developer`, `viewer`; each route declares the permission it needs (`spend:read`, `budget:write`, `policies:write`, `routing:write`, `keys:write`, `approvals:decide`, `audit:read`, `connectors:write`). Every mutation is written to `audit_log`. A test walks the Express router and fails if a route is missing from the OpenAPI table, so `/v1/openapi.json` cannot drift.

## Connectors

`apps/gateway/src/connectors/`: GitHub, Jira, Slack, Linear, Google Analytics 4, Salesforce, CI/CD deployments, and signed custom webhooks. Credentials are verified on create, stored encrypted, never returned. Syncs turn IDs seen in attribution headers into names. Outbound requests pass an SSRF guard; inbound webhooks are HMAC-signed. Currently tested against fixture servers only.

## Dashboard

Next.js app that proxies to the gateway through `app/api/gateway/[...path]`, checking the session first. Sessions are JWTs signed with `JWT_SECRET` (must match the gateway). `AUTH_MODE=open` (local default) skips sign-in; `AUTH_MODE=jwt` requires it. Newer pages (request history, alerts, audit, approvals, connectors) use the management API. Older pages read Postgres directly and fall back to sample data — unifying them is planned.

## Design principles

1. **The request log is immutable.** Only `INSERT` into `transactions`; corrections are new rows. Audit tables are append-only, enforced by the database.
2. **Pricing is versioned.** Never change a price in place; history stays priced as it was. Never invent a price.
3. **Fail open by default.** Enforcement defaults to alert-only. An internal error in policy/budget/routing must not break traffic unless the customer opted into `hard_cap`. The gateway must also work without Redis.
4. **Logging never blocks the request path.** Non-critical writes are fire-and-forget with a disk fallback.
5. **Provider-agnostic core.** Provider differences live only in adapters.
6. **Analytics are SQL, not a service.** Aggregations run on Postgres. ClickHouse/Kafka exist as an optional path and are not required.
7. **Tenant isolation.** Every management query is scoped to the caller's organization.
8. **Secrets are write-only.** Provider keys and connector credentials are encrypted at rest and never returned.
