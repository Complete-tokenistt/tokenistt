# CLAUDE.md — Tokenistt Project Constitution
### Read this first, every session. Accumulated context and guardrails — deviating from it should be a deliberate decision, not a default.

_Last synced to the code: 2026-11-01 (branch `feat/oss-wip`). If the code and this file disagree, check the code, then fix this file._

---

## 1. What Tokenistt is

Tokenistt is an **open-source (Apache-2.0), self-hosted** control plane that sits in front of every AI provider an organization uses: one OpenAI-compatible gateway giving cost visibility, budgets, governance policies with approvals, cost-aware routing, BYOK key management and an audit trail.

**Current external positioning:** *"Open-source AI cost visibility and governance for growing teams."* (This is the README tagline.)

**Never use these framings in customer-facing copy, code comments meant for docs, or generated content, even if asked casually:**
- "Financial Operating System for Enterprise AI"
- "AI FinOps Platform" (invites direct comparison to Portkey/LiteLLM/CloudZero, which we lose)
- Any comparison to "SAP" or "Snowflake" of AI

These were deliberately walked back after diligence found them overscoped relative to what's built and who the team is. For pitch/marketing content, default to the positioning above unless explicitly told it changed again.

> Note: internal module names (`finops-middleware`, `FINOPS_*.md` reports, migration/test names) still say "finops". That is history, not positioning — don't copy it into outward-facing text.

---

## 2. Current stage: OSS release hardening (post-Phase 1 build)

The original Phase 1 scope (cost tracking, budgets, governance, routing, BYOK on a single Postgres, one gateway service) is **built and tested**, and the repo has since been restructured for an open-source release (`apps/` + `packages/`, Apache-2.0, `docker-compose.yml`, `scripts/setup.mjs`, CI, OpenAPI). The work now is making it real: correctness, unifying the older dashboard pages onto the management API, connector validation against live services, and docs.

**Built and working** (verified by the test suites + `npm run test:e2e -w apps/gateway`):
- Auth with virtual keys (`tktt_live_…`), org/workspace/team/project resolution, RBAC (owner / admin / finance / developer / viewer), tenant isolation.
- Policies (`allow`, `block`, `force_model`, `require_approval`) with an approval workflow; append-only `audit_log` and `policy_audit_log` (DB rejects UPDATE/DELETE).
- Scoped budgets (org / team / project / virtual key) in modes `alert_only`, `auto_throttle`, `hard_cap`; deduplicated alerts to Slack / webhook / email.
- Routing rules (`cheapest`, `fastest`, `policy`, `fallback`) with provider failover and a per-provider circuit breaker; BYOK keys (AES-256-GCM) with priority-ordered failover.
- Providers: OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Groq, Together, Gemini, Ollama (the last four via the OpenAI-compatible adapter), plus an offline `mock:` provider (`MOCK_PROVIDER=1`).
- Response cache, prompt whitespace compression, batch endpoint, `GET /v1/logs`, `/metrics`, OpenAPI 3.1 at `/v1/openapi.json`, CSV export.
- Attribution headers (`x-tokenistt-{team,project,repo,ticket,sprint,feature,customer,employee,environment}`) and **connectors** (GitHub, Jira, Slack, Linear, GA4, Salesforce, CI/CD, signed webhooks; SSRF-guarded) that turn IDs into names.
- Dashboard (Next.js 15 / React 19): overview, usage, request history, alerts, shadow AI, budgets, governance, approvals, providers & keys, routing, connectors, audit log, cost attribution, cost centers, chargebacks, unit economics, reconciliation, forecasting, model comparison, team, settings. ROI / board reports / benchmark / simulator are hidden behind `NEXT_PUBLIC_EXPERIMENTAL=1`.
- Also in the repo: `apps/mcp-server` (MCP tools for agents), `packages/sdk-ts`, `packages/sdk-python`, `packages/shadow-ai-scanner`, `packages/credential-manager`, `packages/finops-middleware`.

**Known gaps — be honest about these, in code and in copy** (mirrors README "Known gaps"):
- Connectors are tested against fixture servers, not the live services.
- Older dashboard pages read Postgres directly and fall back to sample data when it's unavailable; only the newer pages (request history, alerts, audit, approvals, connectors) use the gateway management API. Unifying them is planned.
- Not built: SSO (OIDC/SAML), Postgres row-level security, pluggable secrets managers, Redis-Streams event queue for multi-instance, request replay, per-provider latency SLO alerts, `@tokenistt/cli`, dual ESM/CJS SDK build.
- Groq / Together / Gemini models report `COST_UNAVAILABLE` ($0.00) until a price is added to the catalog. **Never invent prices.**
- Single Postgres instance, no multi-region story.

**Still deliberately NOT being built** (do not scaffold, suggest, or default to these without being told the stage has changed):

| Excluded now | Status / reconsider when |
|---|---|
| Prompt Intelligence (embeddings, semantic clustering), Qdrant | A specific paying customer requests exactly this |
| ML-driven Recommendation Engine | Rules-based first, only with enough real usage data |
| ROI / board-report automation, forecasting beyond what exists | Needs external data integrations that are only fixture-tested today |
| New LLM providers | One at a time, only when a real user needs it (adapters are cheap now; *pricing data* is the real cost) |
| Kafka, ClickHouse, S3 | Code exists as an **optional, off-by-default** path (`packages/analytics`, `services/clickhouse.ts`). Don't make it a default or a dependency; only when a specific provable scale problem exists |
| SSO, private deployment, compliance certifications (SOC 2, ISO) | Not planned until there is real demand and a team to support it. Never claim them |
| Multi-region, multi-instance event queue | When a real deployment needs it |

**Redis is now in** — it's used for the rate limiter, virtual-key cache and atomic budget reservation, and is `recommended` (not required unless `REDIS_REQUIRED=true`). Gateway must still behave correctly when Redis is absent.

**The test for anything new:** if it needs its own scaling, its own failure mode, or its own deploy pipeline to make sense, it's a later-stage decision by default — regardless of how good the idea sounds in the moment.

---

## 3. Tech stack (deliberately boring — do not "upgrade" without discussion)

| Layer | Choice | Notes |
|---|---|---|
| Gateway/proxy | Node.js 20+ + TypeScript, Express 5 | Streaming passthrough; `apps/gateway` (ESM, `tsx` for dev/test, `tsc` build) |
| Database | PostgreSQL 16, single instance | SQL migrations in `packages/db/drizzle/*.sql` (currently 0000–0011), run via `npm run migrate`. Don't hand-`ALTER TABLE` |
| Cache / limits | Redis 7 | Rate limiting, key cache, budget reservation; optional at runtime |
| Dashboard | Next.js 15 + React 19 | Talks to the gateway through a session-checked proxy (`app/api/gateway/[...path]`) |
| Auth | Virtual API keys per workspace (customers); JWT sessions (dashboard) | `AUTH_MODE=open` (default locally, no login) or `jwt`. `JWT_SECRET` must match in dashboard and gateway |
| Secrets | `MASTER_KEY` / `ENCRYPTION_KEY`, AES-256-GCM | BYOK keys and connector credentials, write-only |
| Tests / CI | `node:test` via `tsx`, GitHub Actions | CI runs migrate → typecheck → build → test → e2e against real Postgres + Redis |
| Deployment | Docker Compose (`docker-compose.yml`, `infra/docker`), self-hosted | `node scripts/setup.mjs` generates `.env` with fresh secrets and never overwrites one |
| Alerts | Slack webhook + SMTP email + generic webhook | No notification platform |

---

## 4. Repo structure

```
apps/gateway/         ← proxy, management API (/v1/admin/*), policy/budget/routing engines, connectors
apps/dashboard/       ← Next.js product frontend
apps/mcp-server/      ← MCP tools for AI agents (spend, budget status, cost estimate, routing)
packages/db/          ← migrations (drizzle/*.sql), migration runner, schema.ts, demo seed
packages/sdk-ts/      ← @tokenistt/sdk — OpenAI-compatible TypeScript client
packages/sdk-python/  ← Python client
packages/analytics/   ← OPTIONAL ClickHouse/Kafka path, off by default
packages/credential-manager/, shadow-ai-scanner/, finops-middleware/
infra/                ← Dockerfiles, dev compose, Grafana provisioning
scripts/              ← setup.mjs
docs/                 ← PRD, ARCHITECTURE, API, ROADMAP (see §8 — partly stale)
```

`apps/landing/` from the original plan does **not** exist in this repo (the marketing site is separate). `tokenistt-gateway/` at the root is a leftover and not part of the workspaces — don't build on it.

`dashboard` and the marketing site are deliberately separate apps. Don't merge them.

---

## 5. Architecture — the essentials

**Request pipeline, all inside the one gateway service:**
Auth → workspace/team/project resolution → Policy check (incl. approval hold) → Budget check → Routing resolver (rules + failover + circuit breaker) → BYOK key resolver (priority failover) → Provider adapter → Streaming passthrough → Cost calculator → Event logger (async, fail-open to a disk queue that replays when Postgres recovers).

**Provider adapters** (`apps/gateway/src/providers/`) are the single most important abstraction: `base.ts` defines the interface; `openai.ts`, `anthropic.ts`, `azure.ts`, `bedrock.ts`, `openaiCompat.ts` (Groq/Together/Gemini/Ollama), `mock.ts` implement it. **No provider-specific logic (`if provider === 'openai'`) outside an adapter.**

**Core tables (actual names — the old design docs use different ones):**

| Concept | Table |
|---|---|
| Tenant | `organizations`, `workspaces`, `teams`, `projects`, `users` |
| Customer keys | `virtual_keys` |
| BYOK | `provider_keys` |
| Request log (immutable) | `transactions` (partitioned; see `partitionManager.ts`), `hourly_spend` rollups |
| Pricing | `model_catalog` + `pricing_history` (versioned) |
| Enforcement | `budgets`, `budget_alerts`, `policies`, `policy_audit_log`, `routing_rules`, `approval_requests` |
| Audit | `audit_log` (append-only) |
| Attribution | `connectors`, `connector_entities`, `connector_sync_runs`, `unit_metrics` |
| Finance | `provider_invoices` (reconciliation), `request_replays` |

---

## 6. Non-negotiable engineering principles

1. **Request log is immutable.** Never `UPDATE` `transactions`; only `INSERT`. Corrections are new rows. `audit_log` and `policy_audit_log` are append-only, enforced by the database.
2. **Pricing is versioned.** Never change a price in place. Historical requests price against what was true at the time. Unknown model ⇒ `COST_UNAVAILABLE` / $0.00, never a guess.
3. **Fail open by default.** Enforcement (budgets, policies, routing) defaults to alert-only/soft mode. A gateway, Redis or DB hiccup must never silently break a customer's production traffic unless they explicitly opted into hard enforcement (`hard_cap`).
4. **Logging never blocks the request path.** Event/audit writes are fire-and-forget with a disk fallback — never `await` a non-critical write before responding.
5. **Provider-agnostic core.** All provider differences live in the adapter layer.
6. **Analytics are SQL, not a service.** Aggregations run directly on Postgres. The ClickHouse path is optional and off by default.
7. **Tenant isolation.** Every query on the management API is scoped to the caller's organization; budgets are measured only against their own scope's spend. Any new endpoint needs an isolation test.
8. **Secrets are write-only.** Provider keys and connector credentials are encrypted at rest and never returned by any API. Outbound connector URLs go through the SSRF guard.
9. **Schema changes ship as a numbered migration** in `packages/db/drizzle/`, never as an ad-hoc `ALTER`.
10. **Don't claim what isn't verified.** Tests and README "What works today" are the evidence bar; update the README "Known gaps" when a gap closes or opens.

---

## 7. Business context an assistant should know when asked for non-code help

- **Team:** Aryan Singh Bhadoria (CEO), Aditya Tiwari (CPO — also SDE intern elsewhere), Akshay Khanna (CTO). All final-year students at AITR Indore, 2027 batch. Company founded ~February 2026.
- **Stage:** pre-traction. Real, honest numbers: a developer waitlist and LinkedIn following — no paying customers, no revenue, no signed pilots, as of the last update. **Never invent or round up traction numbers in generated content** (pitch decks, website copy, investor materials) — fabricated compliance badges and inflated metrics already damaged credibility once and were explicitly corrected. Open-source stars/downloads/contributors count only if read from the real source at the time.
- **Distribution model:** open source (Apache-2.0) and self-hosted. There is no paid tier or pricing: don't put prices, plans or "Starter/Team/Enterprise" tiers in generated content, and don't reuse any earlier pricing ($299/$799 or $9/$29/$99).
- **Target user/buyer:** an engineering lead or platform owner at a growth-stage AI-native company (10–100 engineers). **Not** an enterprise CFO — that's a later-stage buyer this team isn't positioned to sell to yet.
- **Competitive reality:** real, consolidating market (Portkey→Palo Alto Networks, Langfuse→ClickHouse, Helicone→Mintlify all happened within the same year), and open-source gateways (e.g. LiteLLM) already exist. Don't generate positioning that ignores this or claims an easy win.
- **Website/pitch/README materials:** never add compliance badges (SOC 2, ISO) or claims (prior "9-figure" experience, "published AI-governance research", benchmarks, customer logos) that aren't independently verifiable. Hard line, not a style preference.

---

## 8. Where to find more detail

Accurate, current: `README.md` (what works / known gaps / config / API usage), `/v1/openapi.json` (the real API reference), `apps/gateway/src/tests/` and `apps/gateway/scripts/e2e.mjs` (behaviour as verified), `packages/db/drizzle/*.sql` (actual schema), `.github/workflows/ci.yml`.

**Partly stale — written for the pre-OSS Phase 1 design; verify against the code before relying on them:** `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/ROADMAP.md`, `CONTRIBUTING.md` (they use old table names such as `events`, `workspaces`+`api_keys`, `model_prices`, and still say "two providers" and "no Redis"). Updating them is outstanding work; don't "fix" code to match them.

Dev loop: `npm run dev:deps && npm run migrate` → `npm run typecheck && npm run build` → `npm test` → `npm run test:e2e -w apps/gateway`. CI runs the same steps on Node 20.

If something asked of you conflicts with this file, treat this file as the source of truth for scope and positioning, and flag the conflict rather than silently resolving it in favor of the new instruction.
