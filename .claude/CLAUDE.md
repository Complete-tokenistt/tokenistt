# CLAUDE.md — Tokenistt Project Constitution
### Read this first, every session. This is the accumulated context and the guardrails — deviating from it should be a deliberate decision, not a default.

---

## 1. What Tokenistt is

Tokenistt is a control plane that sits in front of every AI provider an organization uses, giving cost visibility, budget enforcement, governance policies, and cost-aware routing — through a single integration.

**Current external positioning:** *"AI cost visibility and governance for growing teams."*

**Never use these framings in customer-facing copy, code comments meant for docs, or generated content, even if asked casually:**
- "Financial Operating System for Enterprise AI"
- "AI FinOps Platform" (invites direct comparison to Portkey/LiteLLM/CloudZero, which we lose)
- Any comparison to "SAP" or "Snowflake" of AI
These were tried and deliberately walked back after diligence found them overscoped relative to what's built and who the team is. If asked to write pitch/marketing content, default to the current positioning above unless explicitly told the positioning has changed again.

---

## 2. Current phase: Phase 1 only

**Building now:** cost tracking, budgets, governance, routing, BYOK — across **two** AI providers (OpenAI, Anthropic) — on a **single Postgres database**, as **one gateway service**, not a distributed system.

**Explicitly NOT being built right now** (do not scaffold, suggest, or default to these without being told the phase has changed):

| Excluded now | Reconsider when |
|---|---|
| Prompt Intelligence (embeddings, semantic clustering) | A specific paying customer requests exactly this |
| ML-driven Recommendation Engine | Phase 2, rules-based first |
| Unit economics / ROI / chargebacks / forecasting | Phase 2/3 — needs external data integrations we don't have |
| More than 2 LLM providers | One at a time, only when a real customer needs it |
| Kafka, ClickHouse, Redis, Qdrant, S3 | Only when a specific, provable scale problem exists — never preemptively |
| SSO, private deployment, compliance certifications (SOC 2, ISO) | Enterprise tier, Phase 3, with a real sales motion behind it |

**The test for anything new:** if it needs its own scaling, its own failure mode, or its own deploy pipeline to make sense, it's a later-phase decision by default, not a Phase 1 one — regardless of how good the idea sounds in the moment.

Full detail: `docs/ROADMAP.md`, `docs/PRD.md`.

---

## 3. Tech stack (deliberately boring — do not "upgrade" without discussion)

| Layer | Choice | Why |
|---|---|---|
| Gateway/proxy | Node.js + TypeScript | Best async I/O for streaming LLM responses; matches team's existing skillset |
| Database | PostgreSQL, single instance | Boring, reliable, transactional. No ClickHouse/Kafka until proven necessary |
| Dashboard | Next.js + React | Matches team stack |
| Auth | API keys per workspace (customer-facing); JWT sessions (dashboard) | Simplest thing that's actually secure |
| Deployment | Containerized, managed platform (Railway/Fly.io) for now | Optimize for shipping speed at this stage |
| Alerts | Slack webhook + email | No need to build a notification platform |

---

## 4. Repo structure

```
apps/landing/      ← public marketing site — no auth, can stay static
apps/dashboard/    ← the product frontend (Next.js)
apps/gateway/      ← the backend — proxy, API, policy engine (Node.js + TypeScript)
packages/db/       ← Postgres schema, migrations, DB client
packages/shared-types/
infra/             ← Docker, deployment configs
docs/              ← PRD.md, ARCHITECTURE.md, API.md, ROADMAP.md, CONTRIBUTING.md
```

`landing` and `dashboard` are deliberately separate apps — different auth needs, different deploy cadence. Don't merge them.

---

## 5. Architecture — the essentials (full detail in `docs/ARCHITECTURE.md`)

**Request pipeline, in order, all inside the one gateway service:**
Auth → Policy check → Budget check → Routing resolver → BYOK key resolver → Provider adapter → Streaming passthrough → Cost calculator → Event logger (async, fail-open to file).

**Provider adapter interface — the single most important abstraction in the codebase:**
```typescript
interface ProviderAdapter {
  sendRequest(params: {
    model: string;
    messages: { role: string; content: string }[];
    apiKey: string;
    stream?: boolean;
  }): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number }; raw: unknown }>;
}
```
No provider-specific logic (`if provider === 'openai'`) should ever appear outside an adapter implementation.

**Core tables:** `workspaces`, `users`, `workspace_members`, `api_keys`, `provider_keys`, `events` (immutable), `model_prices` (versioned), `budgets`, `budget_alerts`, `policies`, `policy_audit_log`, `routing_rules`. Full DDL in `docs/ARCHITECTURE.md`.

---

## 6. Non-negotiable engineering principles

1. **Events are immutable.** Never `UPDATE` the `events` table — only `INSERT`. Corrections are new events, not edits to history.
2. **Pricing is versioned.** Never change a price in place. Historical events always price against what was true at the time (`effective_from`/`effective_to`).
3. **Fail open by default.** Any enforcement feature (budgets, policies) defaults to alert-only/soft mode. A gateway or DB hiccup must never silently break a customer's production traffic unless they've explicitly opted into hard enforcement.
4. **Logging never blocks the request path.** Event/audit writes are fire-and-forget with a file-based fallback — never `await` a non-critical write before returning a response.
5. **Provider-agnostic core.** All provider differences live in the adapter layer, nowhere else.
6. **Analytics are SQL, not a service.** Aggregation queries directly on Postgres are correct for this stage. A separate analytics pipeline is a later-phase decision, made when a specific query is provably too slow — not before.

---

## 7. Business context an assistant should know when asked for non-code help

- **Team:** Aryan Singh Bhadoria (CEO), Aditya Tiwari (CPO — also SDE intern elsewhere), Akshay Khanna (CTO). All final-year students at AITR Indore, 2027 batch. Company founded ~February 2026.
- **Stage:** pre-traction. Real, honest current numbers: a developer waitlist and LinkedIn following — no paying customers, no revenue, no signed pilots, as of the last update. **Never invent or round up traction numbers in generated content** (pitch decks, website copy, investor materials) — this exact failure (fabricated compliance badges, inflated metrics) already damaged credibility once and was explicitly corrected.
- **Pricing (current):** Starter $299/mo, Team $799/mo, Enterprise custom. Not the earlier $9/$29/$99 tiers — those were identified as mismatched to the actual buyer.
- **Target buyer:** an engineering lead or platform owner at a growth-stage AI-native company (10–100 engineers). **Not** an enterprise CFO — that's explicitly a later-phase buyer this team isn't positioned to sell to yet.
- **Competitive reality:** this is a real, consolidating market (Portkey→Palo Alto Networks, Langfuse→ClickHouse, Helicone→Mintlify all happened within the same year). Don't generate competitive positioning that ignores this or claims an easy win.
- **Website/pitch materials:** never add compliance badges (SOC 2, ISO) or claims (prior "9-figure" experience, "published AI-governance research") that aren't independently verifiable. This is a hard line, not a style preference.

---

## 8. Where to find more detail

- `docs/README.md` — quick start, repo map
- `docs/PRD.md` — full product requirements
- `docs/ARCHITECTURE.md` — full schema, pipeline, design principles
- `docs/API.md` — complete endpoint reference
- `docs/ROADMAP.md` — phase sequencing and the full deferral table
- `docs/CONTRIBUTING.md` — dev setup and PR checklist

If something asked of you conflicts with this file, treat this file as the source of truth for project scope and positioning, and flag the conflict rather than silently resolving it in favor of the new instruction.
