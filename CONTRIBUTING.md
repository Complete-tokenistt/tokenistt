# Contributing to Tokenistt

Tokenistt is Apache-2.0. Contributions are welcome — please read the conventions below before opening a PR.

## Contributor License Agreement

Before we can merge your first pull request, you need to sign the [Contributor License Agreement](CLA.md).
It is a license, not a copyright assignment: you keep the copyright to your work. When you open a PR,
the CLA bot comments with instructions. Sign by replying on the PR with exactly:

```
I have read the CLA Document and I hereby sign the CLA
```

You only sign once; the bot remembers you for future PRs. If the check doesn't update, comment `recheck`.

## Prerequisites

- Node.js 20+
- Docker (for Postgres and Redis during development)
- Provider API keys are optional: the offline `mock:` provider (`MOCK_PROVIDER=1`) exercises the whole pipeline without them

## Local setup

```bash
npm install
npm run dev:deps          # Postgres on :5433 and Redis on :6380
export DATABASE_URL=postgres://tokenistt:tokenistt@localhost:5433/tokenistt
export REDIS_URL=redis://localhost:6380
npm run migrate           # apply packages/db/drizzle/*.sql
node packages/db/seed-demo.mjs   # optional: demo org with synthetic traffic
```

Then run the gateway and the dashboard in separate terminals (`npm run dev:gateway`, `npm run dev:dashboard`) — the README's "Option B — local development" has the exact environment variables. The full stack in containers is `node scripts/setup.mjs && docker compose up --build`.

## Before you push

CI runs these on Node 20 against real Postgres and Redis; run the same locally:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e -w apps/gateway
```

## Conventions

- **Every provider is an adapter** (`apps/gateway/src/providers/`). No provider-specific branching (`if (provider === 'openai')`) outside the adapter layer.
- **The request log is immutable.** Never `UPDATE` or `DELETE` rows in `transactions`; insert a new row for a correction. `audit_log` and `policy_audit_log` are append-only and the database enforces it.
- **Pricing is versioned.** Never change a price in place — add a new price version. Unknown models report `COST_UNAVAILABLE`; never invent a price.
- **Fail open by default.** New enforcement features need an explicit soft/alert-only mode that is the default, and must not break traffic on internal errors. The gateway must keep working without Redis.
- **Logging never blocks the request path.** Event, alert and audit writes are fire-and-forget with a fallback — never `await` a non-critical write before responding.
- **Tenant isolation.** Every management query is scoped to the caller's organization. New endpoints need an isolation test.
- **Secrets are write-only.** Never return provider keys or connector credentials from any endpoint; outbound calls to user-supplied URLs go through the SSRF guard.
- **Schema changes are numbered migrations** in `packages/db/drizzle/`, never a manual `ALTER TABLE`.
- **New management routes** must be added to the table in `apps/gateway/src/openapi.ts` — a test fails otherwise.

## Scope

Check `docs/ROADMAP.md` before adding new infrastructure (a new database, queue, or external service). If a proposal needs its own scaling, failure mode or deploy pipeline to make sense, open an issue to discuss it first rather than a PR.

## PR checklist

- [ ] `typecheck`, `build`, `test` and the e2e script pass
- [ ] Provider logic lives only in an adapter
- [ ] No mutation of `transactions` or the audit tables
- [ ] New enforcement behaviour defaults to soft/alert-only
- [ ] Non-critical writes don't block the response path
- [ ] Schema changes come with a migration
- [ ] New routes are in the OpenAPI table and have tests (including tenant isolation)
- [ ] README "What works today" / "Known gaps" updated if behaviour changed
- [ ] No claims in docs or copy that aren't verified (no compliance badges, benchmarks or customer claims)
