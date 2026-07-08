# Dashboard Integrations (Phase 5)

## Prompt 10 — Shadow AI Expense Scanner → Shadow-AI dashboard

The `shadow-ai-scanner` service (Prompt 10) pushes detected Shadow-AI findings
into this dashboard so the **Shadow AI** view reflects real expense-scan data.

### How it connects
- The scanner's `reporter.ts` POSTs findings to `${DASHBOARD_URL}/api/shadow-ai/scan`.
- This app exposes `POST /api/shadow-ai/scan` (and `GET` to read them) in
  `app/api/shadow-ai/scan/route.ts`. It persists to `data/shadow-ai-ingest.json`.
- `app/shadow-ai/page.tsx` merges the ingested findings with the mock
  `getShadowAi()` data (set `export const dynamic = "force-dynamic"` so it
  refreshes each request).

### Local demo
1. Run the dashboard: `npm run dev` → http://localhost:3000/shadow-ai
   (a sample `data/shadow-ai-ingest.json` is already committed so merged data
   shows immediately).
2. Point the scanner at it: in `shadow-ai-scanner/.env`, set
   `DASHBOARD_URL=http://localhost:3000`, then `npm run scan`. The dashboard's
   Shadow-AI table updates with the scanner's findings.

### Swapping mock data for real
Replace `getShadowAi()` in `lib/mock-data.ts` with a read of
`loadIngestedShadowAi()` (or your ledger/ClickHouse query) to make the Shadow-AI
view fully data-driven.
