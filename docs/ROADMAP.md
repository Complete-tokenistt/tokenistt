# Tokenistt — Roadmap

## Phase 1 — AI Control Layer (current)

Cost tracking, budgets, governance, routing, BYOK — across OpenAI and Anthropic, single Postgres database. See `PRD.md` for full scope and `ARCHITECTURE.md` for implementation.

## Phase 2 — AI Financial Intelligence (next)

Cost attribution, chargebacks, unit economics, forecasting. Requires Phase 1's event data plus externally-provided usage/revenue data (analytics tools, CRM, billing) — a real integration burden, not just more queries on existing data.

## Phase 3 — Financial Operating System for Enterprise AI (long-term)

ROI measurement, investment planning, board-level reporting. Depends entirely on Phase 2's integrations being reliable across most of a customer's tagged features — every Phase 3 number inherits the accuracy of Phase 2's weakest connector.

## Module-by-module deferral table

| Module | Status | Trigger to build |
|---|---|---|
| Prompt Intelligence (embeddings, similarity) | Reconsider | A specific paying customer requests exactly this; treat as its own project |
| Recommendation Engine | Later (Phase 2) | Rules-based first, not ML-driven, once enough real usage data exists |
| ClickHouse | Later | A specific Postgres query is provably too slow for real usage |
| Redis | Later | An actual caching need exists (e.g., policy cache at high volume) |
| Qdrant | Reconsider | Only if/when Prompt Intelligence gets built |
| Kafka | Reconsider | A throughput/decoupling problem exists that a direct DB write can't handle |
| S3 exports | Later | CSV direct-download outgrows what customers need |
| SSO / private deployment / compliance certs | Later (Enterprise, Phase 3) | Real enterprise pipeline with the sales motion to support it |
| More than 2 LLM providers | Now, incrementally | Add one at a time when a specific customer needs it — not preemptively |

## The rule for adding anything not on this list

If a proposed addition needs its own scaling, its own failure mode, or its own deploy pipeline to make sense, it's a later-phase decision by definition — not a Phase 1 one, regardless of how good the idea is.
