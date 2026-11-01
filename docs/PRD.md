# Tokenistt — Product Requirements Document
**Status:** Active · **Stage:** open-source release hardening · **Owner:** Aditya Tiwari (CPO)

---

## 1. Vision

Cloud spend created Cloud FinOps. AI spend is creating the same need for AI infrastructure. Tokenistt is an open-source, self-hosted control layer that gives organizations visibility, budget enforcement and governance over AI spend across every provider, from one integration point.

**Goal:** be the single source of truth for what an organization spent on AI, with whom, and whether it stayed within policy. Prediction, financial intelligence and automation come later, if at all, and only when real users need them.

## 2. Problem

Organizations running AI in production across multiple providers have no unified way to answer basic operational questions: which team is driving spend, whether it's tracking to budget, which models are approved to run, and what's coming next month. Each provider has its own dashboard; nothing aggregates or governs across them.

## 3. Goals

- Real-time spend visibility by team, project, provider and model — and by repo, ticket, sprint, feature, customer and employee when attribution is supplied
- Budgets that alert and enforce before an invoice, not after
- Governance policies (allow, block, force a model, require approval) with an audit trail
- Cost- and latency-aware routing with provider failover
- All of the above across multiple AI providers through one OpenAI-compatible integration
- Trivial to self-host: one `docker compose up`, no login required locally

## 4. Non-goals

| Excluded | Why |
|---|---|
| Prompt analysis / embeddings / semantic clustering | Real ML infrastructure — a separate project, not justified without a specific user need |
| ML-driven recommendations | Rules-based first, and only with enough real usage data |
| Hosted/SaaS operation, paid tiers, pricing | The project is open source and self-hosted |
| Kafka / ClickHouse / S3 as defaults | An optional ClickHouse/Kafka path exists but is off by default; single Postgres is the supported setup |
| SSO, compliance certifications (SOC 2, ISO) | Not built; never claimed |
| ROI and board-level reporting as supported features | Present in the dashboard behind `NEXT_PUBLIC_EXPERIMENTAL=1` only |

## 5. Target users

- **Primary:** an engineering lead or platform owner at a growth-stage, AI-native company (10–100 engineers) with no visibility into fragmented AI spend
- **Secondary:** a finance-adjacent stakeholder, brought in after the engineering lead adopts the tool
- **Not the target:** an enterprise CFO or procurement-led buyer

## 6. Functional requirements

### Identity & access
- Virtual API keys per workspace (shown once, stored hashed), revocable with history kept
- Dashboard sign-in with JWT sessions (`AUTH_MODE=jwt`), or open local mode (`AUTH_MODE=open`)
- Roles: owner, admin, finance, developer, viewer; per-route permissions; tenant isolation

### Gateway
- OpenAI-compatible `POST /v1/chat/completions` with streaming passthrough, plus a batch endpoint
- Providers: OpenAI, Anthropic, Azure OpenAI, AWS Bedrock, Groq, Together, Gemini, Ollama, and an offline `mock:` provider
- Every request recorded as an immutable event: organization, team, project, attribution dimensions, provider, model, tokens (input, output, cache, reasoning), cost, latency, status
- Optional response cache and prompt whitespace compression

### Cost tracking
- Spend by team / project / provider / model and by attribution dimension; trends over time
- Cost from a versioned price catalog; unknown models report `COST_UNAVAILABLE`, never a guess

### Budgets
- Scoped to organization / team / project / virtual key, each measured against its own spend
- Period, cap, warning and critical thresholds
- Enforcement modes: `alert_only` (default), `auto_throttle`, `hard_cap`
- Deduplicated alerts to Slack, webhook or email; visible alert history

### Governance
- Policies on model, team, environment, prompt keywords and more
- Effects: allow, block, force a model, require approval
- Approval flow: held request → admin approves or denies → caller retries
- Every decision in an append-only audit trail

### Routing
- Strategies: cheapest, fastest, policy, fallback; evaluated in priority order
- Failover across targets with a per-provider circuit breaker
- Dry-run simulation before activating

### BYOK
- Provider keys per organization/workspace, encrypted at rest, never shown after creation
- Priority-ordered failover across keys, then providers

### Attribution & connectors
- GitHub, Jira, Slack, Linear, Google Analytics 4, Salesforce, CI/CD deployments, signed custom webhooks
- Synced names join to attribution headers in the cost views

### Dashboard
- Overview, usage, request history, alerts, shadow AI, budgets, governance, approvals, providers & keys, routing, connectors, audit log, cost attribution, cost centers, chargebacks, unit economics, reconciliation, forecasting, model comparison, team, settings

### Agents
- MCP server exposing spend summary, budget status, cost estimate and routing to AI agents

## 7. Non-functional requirements

- **Reliability:** fails open — an internal error in enforcement never silently breaks production traffic unless the budget is explicitly `hard_cap`; the gateway works without Redis; event writes queue to disk if Postgres is down
- **Latency:** proxy overhead small relative to provider latency; streaming is unbuffered
- **Security:** secrets encrypted at rest (AES-256-GCM) and write-only; SSRF guard on outbound connector calls; signed inbound webhooks; hardened HTTP headers
- **Data integrity:** the request log is insert-only; audit tables reject `UPDATE`/`DELETE`; request IDs are idempotent
- **Auditability:** every admin action and every automated policy/budget/routing decision is logged and attributable

## 8. Success criteria

Met when someone can clone the repo, run `node scripts/setup.mjs && docker compose up`, route real traffic, see accurate spend, hit a budget alert, block or hold a request with a visible audit trail, and use the dashboard as the place they check — **with real self-hosting users**, not merely a demo. Today's verified behaviour and known gaps are listed in the README.

## 9. Open risks

- Connectors are verified against fixture servers, not the live services
- The older dashboard pages still read Postgres directly and can show sample data when it's unavailable
- Price catalog coverage is incomplete (Groq / Together / Gemini models report `COST_UNAVAILABLE`)
- Requests without team/project headers are not attributed to a team or project budget; users need to set the headers
- No automated detection of upstream provider pricing or API changes — a manual process
- Single Postgres instance and a disk-based fallback queue limit multi-instance and multi-region deployments
