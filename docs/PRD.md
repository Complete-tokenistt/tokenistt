# Tokenistt — Product Requirements Document
**Status:** Active · **Phase:** 1 · **Owner:** Aditya Tiwari (CPO)

---

## 1. Vision

Cloud spend created Cloud FinOps. AI spend is creating the same need — but for AI infrastructure. Tokenistt is building the control layer that gives organizations visibility, budget enforcement, and governance over AI spend across every provider, from one integration point.

**Phase 1 goal:** become the single source of truth for what an organization spent on AI, with whom, and whether it stayed within policy. Prediction, financial intelligence, and automation are later phases — not this one.

## 2. Problem

Organizations running AI in production across multiple providers have no unified way to answer basic operational questions: which team is driving spend, whether it's tracking to budget, which models are approved to run, and what's coming next month. Each provider has its own dashboard; nothing aggregates or governs across them.

## 3. Goals

- Real-time spend visibility broken down by team, project, provider, and model
- Budgets that alert and enforce before an invoice, not after
- Governance policies restricting which models/providers can run, with an audit trail
- Cost- and latency-aware routing across providers
- All of the above across at least two AI providers through one integration

## 4. Non-goals (Phase 1)

| Excluded | Why |
|---|---|
| Prompt analysis / embeddings / semantic clustering | Real ML infrastructure — separate project, not justified without a specific paying customer |
| Automated ML-driven recommendations | Phase 2, and rules-based even then |
| Unit economics / ROI / chargebacks | Phase 2/3 — needs external data integrations Phase 1 doesn't have |
| More than 2 providers at launch | Add only when a real customer needs it |
| Kafka, ClickHouse, Redis, Qdrant, S3 | Solve scale/use-case problems this stage doesn't have; single Postgres is correct for now |
| SSO, private deployment, compliance certs | Enterprise tier, Phase 3 |

## 5. Target users

- **Primary:** an engineering lead or platform owner at a growth-stage, AI-native company (10–100 engineers) with no visibility into fragmented AI spend
- **Secondary:** a finance/FinOps-adjacent stakeholder, brought in after the eng lead adopts the tool
- **Explicitly not the Phase 1 buyer:** an enterprise CFO — longer sales cycle than this stage can serve

## 6. Functional requirements

### Identity & Workspace
- Sign up, create a workspace, invite members with roles (owner/admin/member/billing)

### Gateway / Ingestion
- Issue API keys that route application traffic through Tokenistt
- Proxy requests to OpenAI and Anthropic transparently, preserving streaming
- Capture every request as an immutable event (team, project, provider, model, tokens, cost, latency, status)

### Cost Tracking
- Spend by team/project/provider/model, trends over time, current-period forecast
- Cost calculated from a versioned pricing table — historical requests keep the price that was true at the time

### Budgets
- Scoped to workspace/team/project, with period and limit
- Configurable alert thresholds
- Three enforcement modes: alert-only, auto-throttle, hard cap
- Visible alert history

### Governance
- Allow/deny policies by model, team, environment, time window
- Evaluated pre-flight, before any provider call
- Every decision logged in an audit trail

### Routing
- Cost-based, latency-based, policy-based, and fallback-on-outage rules
- Evaluated in priority order
- Simulatable before activation

### BYOK
- Connect provider keys per workspace
- Multi-key failover on rate/budget limits
- Encrypted at rest, never displayed in plaintext after creation

### Dashboard
- Overview, Usage, Budgets, Governance, Providers & Keys, Routing, Settings

## 7. Non-functional requirements

- **Reliability:** fails open by default — an outage never silently breaks production traffic unless a workspace explicitly opts into hard enforcement
- **Latency:** proxy overhead in the single- to low-double-digit milliseconds; streaming passes through unbuffered
- **Security:** provider keys encrypted at rest; key management restricted to admin/owner roles
- **Data integrity:** events are immutable; retries are idempotent
- **Auditability:** every governance and budget enforcement action is logged and attributable

## 8. Success criteria

Met when an organization can complete the full loop — connect a provider, route real traffic, see accurate spend, set and hit a budget alert, block a disallowed model with a visible audit trail, and use the dashboard as the single place they check — **with real design partners using real traffic**, not merely a feature list demoed internally.

## 9. Open risks

- Fail-open vs. fail-closed default needs to be unambiguous before any pilot goes live
- Untagged request handling (team/project) needs a defined bucket, not silent loss
- BYOK encryption approach needs an internal security review before real production keys connect
- No automated detection yet for upstream provider pricing/API changes — accepted as a manual-process risk for now
