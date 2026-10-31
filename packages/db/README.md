# Tokenistt Transaction Ledger (Phase 3 — Database & Analytics)

Financial-grade Postgres schema for multi-tenant AI usage tracking with
cost-center rollups, key-level budget caps, and vendor reconciliation.

## Files

| File | Purpose |
| --- | --- |
| `drizzle/0000_init.sql` | **Authoritative DDL.** Tables, FKs, exact-decimal money, composite + BRIN + partial indexes, monthly partitioning, partition-maintenance function. |
| `drizzle/views.sql` | Materialized views (provider / cost-center / workspace / actor / key / reconciliation) with unique indexes for `CONCURRENTLY` refresh. |
| `drizzle/queries.sql` | Sample FinOps queries — the two headline questions + budget, shadow-AI, amortization, reconciliation. |
| `drizzle/schema.ts` | Drizzle typed model (mirrors the DDL). |
| `prisma/schema.prisma` | Prisma alternative (run `prisma migrate`, then apply partitioning/BRIN/partial-index SQL from `0000_init.sql`). |

Apply order: `0000_init.sql` → `views.sql` → (optionally) `queries.sql`.

## ER diagram

```
organizations 1──┐
   │            ├──┬─ users 1──┐
   │            │  └─ workspaces 1──┐
   │            │        │          │
   └── virtual_keys ─┐    │          │
        │             │    │          │
        └──────── transactions ───────┘
                     │
        provider_invoices ── (reconciliation by org+provider+period)
```

`transactions` carries the **denormalized** `cost_center` and `actor` so the
most common FinOps queries avoid joins and hit a single composite index.

## FinOps-critical fields

| Field | Type | Why |
| --- | --- | --- |
| `cost_usd` | `numeric(18,6)` | **Exact decimal, never float** — required for financial accuracy and audits. |
| `amortized_cost_usd` | `numeric(18,6)` | Cache-**write** cost (prompt-cache creation) is recorded once, then spread across the cache-**read** calls as a small slice, so each read reflects its true marginal cost. |
| `cost_center` | `text` | Accounting code, e.g. `CC-4401-Support`; indexed for rollups. |
| `project_tag` | `text` | Optional second dimension for granular tracking (partial-indexed). |
| `shadow_ai_flag` | `boolean` | True when a call is detected outside approved channels (partial-indexed for fast shadow-AI reports). |
| `actor` / `user_id` | `text` / FK | The SDK `user` attribution — enables "Sarah's spend" without always joining `users`. |
| `cache_creation_tokens` / `cache_read_tokens` | `int` | Feed the amortization math and cache-efficiency analytics. |

All money is `numeric` with explicit precision/scale; `cost_usd >= 0` and
`status` / `budget_period` are guarded by `CHECK` constraints.

## Indexing strategy

Two headline queries drive the design:

1. **"Sarah's spend in the Support team last week"**
   → `ix_txn_costcenter_actor_created (cost_center, actor, created_at DESC)`.
   `cost_center` is stored on the row, so no JOIN is needed.

2. **"Total cost by provider for CFO dashboard"**
   → served by `mv_cost_by_provider_daily` (pre-aggregated, hits
   `uq_mv_provider_daily`); the raw path uses
   `ix_txn_provider_created (provider, created_at DESC)`.

Extras: `workspace + created_at`, `actor + created_at`, two **partial**
indexes (`shadow_ai_flag`, `project_tag IS NOT NULL`), a `public_id` lookup
index, and a **BRIN** index on `created_at` for cheap time-range scans on
very large append-only tables.

## Partitioning

`transactions` is `PARTITION BY RANGE (created_at)` (monthly). Benefits:
partition pruning for time-bound queries, fast per-month `DETACH`/drop for
retention, and smaller per-partition indexes. A `transactions_default`
partition catches gaps; `ensure_transactions_partition(for_date)` (called from
`pg_cron` or app startup) creates the next month automatically.

## Materialized views (rollups)

Refreshed `CONCURRENTLY` on a schedule (e.g. every 15 min via `pg_cron`):

- `mv_cost_by_provider_daily` — CFO "cost by provider"
- `mv_cost_by_cost_center_daily` — cost-center rollup + budget variance
- `mv_cost_by_workspace_daily` — team rollup
- `mv_cost_by_actor_daily` — per-user leaderboards
- `mv_virtual_key_spend_monthly` — key budget-cap enforcement
- `mv_provider_reconciliation` — ledger cost vs. actual vendor invoice

Each has a **unique index** so `REFRESH MATERIALIZED VIEW CONCURRENTLY` works
without blocking reads.

## Wiring to the SDK (Phase 1–2)

The gateway records one `transactions` row per API call, populating:
- `actor` ← SDK `user` header (`X-Tokenistt-User`)
- `cost_center` ← SDK `cost_center` header (`X-Tokenistt-Cost-Center`)
- `virtual_key_id` ← resolved from the API key
- `cost_usd` ← gateway's `computeCost(model, usage)` (same pricing table as the
  Node/Python SDKs)
- `provider` / `model` / `usage` fields from the upstream response
- `shadow_ai_flag` ← set when the call bypasses the approved gateway

`provider_invoices` is loaded from the vendor bill (CSV/API) for reconciliation.

## Notes / extensions

- `char(3)` for `currency` keeps it fixed-width and indexed cheaply.
- `metadata jsonb` holds arbitrary attribution (region, env, request tags).
- For true multi-region, add a `region` column + include it in the composite
  indexes as needed.
- TypeORM users: the Prisma/Drizzle models map 1:1; emit the same DDL (the SQL
  in `0000_init.sql` is ORM-agnostic).
