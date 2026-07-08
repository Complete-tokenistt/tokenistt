# Tokenistt CFO Dashboard (Phase 4 · Prompt 7)

A **Next.js 14 (App Router)** FinOps dashboard that consolidates AI spend across
all providers — built on top of the Phase 3 backends (Postgres ledger → Prompt 5,
ClickHouse analytics → Prompt 6).

## Stack

- **Next.js 14** (App Router, RSC + client components)
- **Tailwind CSS** — styling
- **Recharts** — provider pie chart
- **TanStack Table v8** — sortable cost-center / shadow-AI / reconciliation tables
- **pdf-parse** — server-side PDF invoice extraction (CSV is parsed client-side)

## Run

```bash
cd dashboard
npm install
npm run dev
# open http://localhost:3000
```

## Views

| Route | View | What it shows |
| --- | --- | --- |
| `/` | **Executive Summary** | Spend vs budget, MoM growth, top 3 cost centers, anomaly alerts, Shadow-AI exposure |
| `/providers` | **Provider Breakdown** | OpenAI vs Anthropic vs Bedrock (+ Google/Mistral) spend as a pie + table |
| `/cost-centers` | **Cost Center Drill-down** | Sortable table (Engineering $5.2K, Support $3.1K, …) with MoM growth |
| `/reconciliation` | **Invoice Reconciliation** | Upload a vendor invoice (CSV/PDF) → variance vs ledger-calculated cost |
| `/shadow-ai` | **Shadow AI** | Unauthorized usage from card / browser / expense integrations, with acknowledge/approve |
| `/team` | **Team Manager** | Team-scoped: per-member spend, budget bars (Sarah $45/$50), GPT-4 vs Haiku model mix, alert config |
| `/benchmark` | **Benchmarking (A/B)** | Upload prompt/expected CSV, pick models, run simulated eval w/ progress, compare cost/accuracy/latency/quality, "Switch to this model" |

## Data flow

```
Prompt 5 (Postgres) ┐
                    ├─► Tokenistt gateway ─► ClickHouse (Prompt 6) ─► this dashboard
Prompt 6 (ClickHouse)┘
```

This scaffold ships with a **deterministic mock data layer** in
`lib/mock-data.ts` so it runs with zero infrastructure. Every getter
(`getSummary`, `getProviderBreakdown`, `getCostCenters`, `getAnomalies`,
`getShadowAi`, `getInvoices`, `reconcile`) mirrors the schemas from Prompts 5–6,
so wiring real data is a one-file change:

1. Point each `get*` in `lib/mock-data.ts` at your API/DB (or call the
   `app/api/*` routes that already wrap them).
2. The component layer (`components/*`, `app/*/page.tsx`) needs **no changes** —
   it only depends on the TypeScript types in `lib/types.ts`.

### API contract

The `app/api/*/route.ts` files already expose the same data the pages render:

- `GET /api/summary`
- `GET /api/providers`
- `GET /api/cost-centers`
- `GET /api/anomalies`
- `GET /api/shadow-ai`
- `GET /api/team` — Team Manager View (team-scoped)
- `GET /api/benchmark` — available models + profiles for A/B testing
- `POST /api/reconciliation` — `{ invoices }` → reconciled rows
- `POST /api/reconciliation/upload` — multipart invoice file → parsed `invoices`

Swap the server components' `lib/mock-data` imports for `fetch("/api/...")` calls
when you want the UI fully decoupled from the data source.

## Invoice upload

- **CSV**: parsed in the browser (no server round-trip for parsing). Tolerant
  header mapping — `provider/vendor`, `period/month`, `billedUsd/amount/total`,
  `currency`. A "Download sample CSV" link is provided.
- **PDF**: sent to `/api/reconciliation/upload`, text-extracted with `pdf-parse`,
  then best-effort line-item detection (`lib/invoice-parse.ts`). Real vendor PDFs
  vary — tune the extractor (or use a hosted OCR service) for production.

## Notes

- All money is handled as exact decimal `number` values here (formatting via
  `lib/format.ts`); the underlying ledgers store `numeric(18,6)` / `Decimal64(6)`
  per Prompts 5–6, so no float drift occurs at the source.
- The dashboard is read-optimized for CFO review; write actions (Shadow-AI
  acknowledge/approve) are local client state in this scaffold and would persist
  to the ledger in production.

### Live benchmarking (Prompt 9)

The Benchmarking page (`/benchmark`) can run **real** evaluations through the
Tokenistt gateway SDK (`@tokenistt/sdk`, Prompt 3), linked as a local
`file:..` dependency. `POST /api/benchmark/run` calls each selected model for
every prompt, measures latency, accumulates cost via the SDK's `onUsage`
callback, and scores `accuracy` (exact/containment) + `quality` (heuristic).

- **Live mode**: set `TOKENISTT_BASE_URL` + `TOKENISTT_API_KEY` (see
  `.env.example`), or paste them into the "Gateway URL / API key" fields on the
  page. With both present, the route evaluates for real.
- **Simulated mode** (default): with no gateway configured, the route returns
  deterministic aggregate results from `lib/benchmark-data.ts` so the full UX
  works end-to-end without credentials.

> For production scale, move the loop into a real background job (queue + job
> id + progress polling) instead of a single long request.
