# Tokenistt Shadow AI Scanner (Prompt 10 — Phase 5)

A background worker that scans **Brex / Ramp / Navan** expenses for AI-tool
subscriptions, matches the spender to your user directory, and flags
**Shadow Spend** — AI usage paid for personally (no corresponding corporate
gateway activity). It computes **True Cost** = corporate API spend + expensed
subscriptions, and pushes findings into the Prompt 7 Shadow-AI dashboard.

## What it does (your requirements)

| Requirement | Where |
| --- | --- |
| **OAuth with Brex/Ramp** | `src/oauth.ts` — `getAuthUrl()` + `exchangeCode()`; token store in `src/tokenStore.ts` |
| **Scan descriptions for OpenAI/ChatGPT/Claude/Anthropic/Perplexity** | `src/scanner.ts` — keyword rules over `description + merchant` |
| **Match employee email → user DB** | `src/users.ts` — `findUserByEmail()` (config-driven, pluggable) |
| **Flag Shadow Spend if no gateway usage** | `src/matcher.ts` + `src/gateway.ts` — `shadow = !hasGatewayUsage` |
| **True Cost = API spend + expensed subs** | `ShadowFinding.trueCostUsd = apiSpendUsd + amount` |
| **Daily background worker → dashboard** | `src/worker.ts` (BullMQ) + `src/queue.ts` (cron) + `src/reporter.ts` |

## Architecture

```
Brex/Ramp APIs ──OAuth──▶ fetchTransactions ──▶ scanner (keyword match)
                                                    │
                                          users.findUserByEmail
                                                    │
                                          gateway.getGatewayUsage (corporate?)
                                                    │
                                          matcher → ShadowFinding (shadow? trueCost?)
                                                    │
                                    store.saveResult + reporter → Dashboard API
                                                    │
                                            (BullMQ daily job, 06:00)
```

## Run

```bash
cd shadow-ai-scanner
npm install
cp .env.example .env      # fill Brex/Ramp OAuth creds + SCANNER_ORGS

# Option A — production: BullMQ worker + scheduled daily scan (needs Redis)
npm run worker

# Option B — one-off, no Redis (great for local testing)
npm run scan
```

`npm run scan` writes `data/shadow-ai-results.json`, `data/shadow-ai-findings.json`
(dashboard-compatible), and JSONL history. A sample result is committed under
`data/` so you can see the shape immediately.

## Wiring to real systems

- **OAuth**: implement the callback route in your auth service; call
  `exchangeCode(provider, code, orgId)` to persist tokens.
- **User directory**: replace `findUserByEmail` with a query to your IdP/gateway
  user store (it already returns `{ email, actor }` where `actor` is the
  `X-Tokenistt-User` value).
- **Gateway usage check**: set `GATEWAY_URL` to your Tokenistt gateway's
  `/internal/usage` endpoint. With it unset, every AI expense with no matched
  corporate usage is (correctly) treated as shadow.
- **Dashboard**: set `DASHBOARD_URL` (the Prompt 7 Next.js app). Findings are
  POSTed to `${DASHBOARD_URL}/api/shadow-ai/scan` and merged into the Shadow-AI
  view.

## Notes

- Amounts from Brex/Ramp are normalized from minor units (cents → dollars); the
  divisor in `providers/*.ts` is documented if your app differs.
- `GATEWAY_URL` unset ⇒ `hasGatewayUsage = false` ⇒ all AI expenses are flagged
  shadow. This is intentional for the default/demo path.
- The worker is idempotent per run; findings are recomputed each scan.
