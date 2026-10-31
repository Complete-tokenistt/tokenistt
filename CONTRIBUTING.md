# Contributing to Tokenistt

## Prerequisites

- Node.js 20+
- A Postgres instance (local via Docker, or a managed instance — Railway/Supabase/Neon)
- Sandbox API keys for OpenAI and Anthropic (for local testing)

## Local setup

```bash
npm install
cp apps/gateway/.env.example apps/gateway/.env   # fill in DATABASE_URL, ENCRYPTION_KEY
npm run db:migrate --workspace=packages/db
npm run dev --workspace=apps/gateway
npm run dev --workspace=apps/dashboard             # separate terminal
```

## Conventions

- **Every provider implements `ProviderAdapter`** (see `ARCHITECTURE.md`). No provider-specific `if/else` branching outside the adapter layer — if you find yourself writing `if (provider === 'openai')` in a route handler, that logic belongs in the adapter instead.
- **Events are immutable.** Never write an `UPDATE` against the `events` table. If a correction is needed, log a new event, don't mutate history.
- **Pricing is versioned.** Never change a price in place — insert a new `model_prices` row with a new `effective_from` and close out the old one's `effective_to`. Historical events must always price against what was true at the time.
- **Fail open, not closed, by default.** Any new enforcement feature (budgets, policies) needs an explicit soft/alert-only mode, and that should be the default unless a workspace has opted into stricter enforcement.
- **Logging never blocks the request path.** Event logging, alerting, and audit writes are async with a fallback (see the request pipeline in `ARCHITECTURE.md`) — never `await` a non-critical write before returning a response to the client.

## Before adding new infrastructure

Check `ROADMAP.md`'s deferral table first. If you're about to add a new database, queue, or external service, confirm it's not already listed there as "Later" or "Reconsider" — and if it's not on the list at all, ask whether it needs its own scaling/failure mode/deploy pipeline to make sense. If yes, it's a Phase 2/3 discussion, not a PR.

## PR checklist

- [ ] New provider logic lives only in an adapter, not scattered across routes
- [ ] No `events` table mutations, only inserts
- [ ] New enforcement behavior defaults to soft/alert-only
- [ ] Non-critical writes (logging, alerts) don't block the response path
- [ ] Schema changes come with a migration, not a manual `ALTER TABLE` note in Slack
