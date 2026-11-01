# Tokenistt — Roadmap

Tokenistt is open source (Apache-2.0) and self-hosted. This roadmap is about what to build next and what to leave alone. For what works today and the known gaps, see the README.

## Where we are

The original scope — cost tracking, budgets, governance, routing and BYOK on a single Postgres behind one gateway — is built and covered by tests and an end-to-end script. The repo has been restructured for an open-source release. Built: virtual-key auth, RBAC, policies with approvals, scoped budgets, routing with failover and a circuit breaker, BYOK with key failover, eight providers (plus an offline `mock:` one), attribution headers and connectors, an append-only audit trail, a response cache, a batch endpoint, an OpenAPI document, and a dashboard.

## Now — make what exists real

1. **Unify the older dashboard pages** (Overview, Usage, Budgets, Governance, Routing, Providers, Team, Forecasting …) onto the management API, and stop falling back to sample data silently.
2. **Validate connectors against live services.** They are tested against fixture servers only; expect small fixes on first real use.
3. **Fill the price catalog** for Groq, Together and Gemini models, which report `COST_UNAVAILABLE` until priced.
4. **Documentation and onboarding** — keep these docs accurate, and keep first run clean (`node scripts/setup.mjs` → `docker compose up`).
5. **Real-user feedback** from people self-hosting it, before adding scope.

## Next — reasonable follow-ups

- `@tokenistt/cli`; a dual ESM/CJS SDK build.
- Request replay; per-provider latency SLO alerts.
- Pluggable secrets managers (AWS / Vault / Azure).
- Postgres row-level security as defence in depth for tenant isolation.
- Rules-based recommendations (e.g. "this feature could use a cheaper model") once there is enough real usage data.

## Later — only with a concrete trigger

| Module | Status | Trigger to build |
|---|---|---|
| SSO (OIDC/SAML) | Not built | A self-hosting organization needs it and someone can maintain it |
| Redis-Streams event queue (multi-instance) | Not built | A deployment runs more than one gateway instance and the disk fallback isn't enough |
| ClickHouse / Kafka | Optional path exists (`packages/analytics`), off by default | A specific Postgres query is provably too slow on real data |
| Unit economics, ROI, chargebacks, forecasting beyond what exists | Partly built, treat as experimental | The inputs (analytics, CRM, billing) are connected and verified in real deployments — every downstream number inherits the accuracy of its weakest connector |
| Prompt Intelligence (embeddings, similarity), Qdrant | Not planned | A specific user asks for exactly this; treat as its own project |
| ML-driven recommendations | Not planned | Rules-based version first, then evidence it falls short |
| More providers | Incremental | A real user needs one; the adapter is cheap, accurate pricing data is the real cost |
| Multi-region | Not planned | A real deployment needs it |
| Compliance certifications (SOC 2, ISO) | Not planned | Never claimed until independently obtained |

## The rule for adding anything not on this list

If a proposed addition needs its own scaling, its own failure mode, or its own deploy pipeline to make sense, it's a later-stage decision by default — regardless of how good the idea is.
