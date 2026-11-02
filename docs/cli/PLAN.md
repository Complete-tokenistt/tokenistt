# Plan: `tokenistt` CLI (apps/cli)

## Context
CLAUDE.md lists `@tokenistt/cli` as "not built". Goal: a real CLI that is a thin client over the existing gateway, so CLI and dashboard read the same `transactions` ledger (no parallel analytics DB). Positioning stays "open-source AI cost visibility and governance" (no "FinOps platform" copy). No prices invented; unknown model => `COST_UNAVAILABLE`.

## Audit findings (what exists, reuse)
- Gateway `apps/gateway` (Express 5): `/v1/admin/*` management API (budgets, policies, routing-rules, models, projects/teams/workspaces, provider-keys, keys, connectors, attribution, requests, reports/export), RBAC via `middleware/adminAuth.ts` (X-Admin-Secret or dashboard HS256 JWT). `/v1/logs`, `/v1/usage/me` auth by virtual key (`tktt_live_…`).
- Ledger: `transactions` (immutable, partitioned), request_id dedupe via `WHERE NOT EXISTS` (migration 0010); pricing in `services/pricing.ts` + `model_catalog`/`pricing_history` (`pricingDb.ts`). Policy engine: `db/policies.ts` `checkPolicies`, enforced in `/v1/chat/completions`.
- SDK `packages/sdk-ts` (OpenAI-compatible, cjs), MCP server `apps/mcp-server` (reads dashboard `/api/gateway/*`), CI = Node 20.
- **Missing**: CLI; usage ingest endpoint for SDK/local telemetry; aggregate-by-dimension endpoint (only `v_cost_by_dimension`); policy dry-run endpoint; device/browser login.

## Architecture
`apps/cli` (workspace, npm name `tokenistt`, bin `tokenistt`, tsc build, ESM). Layers: commands (commander, no logic) -> services (pure, typed, no terminal I/O) -> `ApiClient` (gateway HTTP) / `LocalStore` (SQLite) / provider adapters. Renderers (table/json/csv) separate. Deps: commander, zod, yaml only. Exit codes: 0 ok, 1 error, 2 usage, 3 auth, 4 network, 5 policy-blocked. Flags: --json --quiet --verbose --no-color; non-TTY => non-interactive.

Deliberate deviations from the brief (reasons):
- **Tests via `node:test` + tsx**, not Vitest (repo convention). **tsc**, not tsup.
- **SQLite via `node:sqlite`** (no native dep). Requires Node >=22.13; repo CI is Node 20 => add a Node 22 CLI job. Alternative: better-sqlite3 (native prebuild risk).
- **Credentials**: no keychain native dep. 0600 file in OS config dir + env override (`TOKENISTT_API_KEY/_API_URL/_PROJECT_ID`). Documented limitation; keychain is follow-up.
- **Browser/device login deferred**: needs dashboard approval page + device-code migration. v1 `login` = API URL + management token (JWT/admin secret) or virtual key, validated against the gateway. Documented as known gap.
- **Mistral**: no gateway adapter exists; CLAUDE.md says new providers only on real demand. v1 supports openai, anthropic, gemini, groq, together, ollama, openai-compatible (existing adapters). Mistral reachable via openai-compatible; no dedicated adapter.
- **Pino/@clack** skipped: small redacting logger + readline prompts instead.
- Cloud-only features not faked: offline `sync` queues; reads need the gateway.

## Backend additions (gateway, each with tests incl. tenant-isolation)
1. `POST /v1/ingest/events` (virtual-key auth, rate-limited, <=500 events, schema_version, zod-style validation). Server computes cost via existing pricing (CLI never sends cost). Idempotent on `request_id = cli:<event_id>`; per-event result (accepted/duplicate/rejected). Attribution (project/team slug, customer, feature, environment, user->actor, lead/session->metadata) stored on existing columns. Fail-open, no prompts stored.
2. `GET /v1/admin/usage/summary?group_by=&since=&until=` — whitelist group_by (provider, model, actor, customer, endpoint, project, feature, lead, day); tokens, cached tokens, cost, requests, error rate, p50/p95 latency. Powers usage/cost/attribution/optimize.
3. `GET /v1/admin/whoami` and `POST /v1/admin/policies/test` (dry-run `checkPolicies`, audit-logged).
4. Project registration reuses `POST /v1/admin/projects`. Policy CRUD reuses existing routes. No new migration expected.

## CLI command mapping
- auth: login/logout/auth status|whoami|configure; connect/disconnect/connection status/sync/--force (health check, retry+exponential backoff, offline detection).
- init: detect lang/framework/pkg-manager/provider SDKs; write `.tokenistt` (zod-validated); register project; generate SDK instrumentation snippet / env wiring (no silent source rewrites; prompts to confirm); validate by sending a probe event.
- providers add|list|test|remove -> `/v1/admin/provider-keys` (write-only secrets) + provider reachability test.
- usage / cost / attribution (users|customers|leads|endpoints) / models (list|compare|pricing|recommend) -> summary + `/v1/admin/models`; CSV export; pricing is from gateway catalog only.
- policy list|create|validate|check|apply|test (YAML -> gateway policies; dry-run default for apply with `--yes`); enforcement stays at gateway/proxy boundary (documented: SDK-only path cannot block).
- optimize: rules-based on aggregates (model over-provisioning, repeated-prompt/caching candidates via token ratios, retries, expensive endpoints, provider comparison). Each finding: inefficiency, evidence, change, estimated savings range (only when prices known), trade-offs, confidence. Never auto-applies.
- doctor: node version, auth, gateway /health, API reachability, provider creds, project config, local DB, sync queue, policy config; actionable fixes.
- Local mode: SQLite `events` + `outbox`; SDK/wrapper `@tokenistt/sdk` hook records events locally (non-blocking), `sync` flushes in batches with idempotent ids, backoff, never drops on failure.

## Delivery (per memory: one PR per change, CI parity first, merge on green)
1. PR1 docs: `docs/cli/PLAN.md` (this plan) — merge when green.
2. PR2 gateway endpoints + tests (+ openapi, README gap note).
3. PR3 CLI foundation: config, auth, ApiClient, output, doctor, tests.
4. PR4 usage/cost/attribution/models/providers.
5. PR5 init + local store + sync + instrumentation.
6. PR6 policy + optimize.
7. PR7 docs (docs/cli/*), npm release workflow (changesets-less: tag-driven publish with provenance), update CLAUDE.md/README known gaps.

## Verification
`npm run typecheck && npm run build && npm test` (CLI on Node 22), `npm run test:e2e -w apps/gateway`, new CLI e2e: start gateway with mock provider + Postgres, `tokenistt login` -> `init` -> instrumented mock call -> `sync` -> `usage`/`cost` match dashboard `/api/gateway` numbers -> `policy apply/test` blocks a request. Opt-in live provider tests gated by env keys. Report only what actually ran.

## Honest limits to document
No browser login, no keychain, no Mistral adapter, connectors/live providers fixture-tested only, currency conversion not implemented (USD), SDK-only mode records but cannot enforce.
