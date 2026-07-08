# Tokenistt

**AI cost visibility and governance for growing teams.**

Tokenistt is a control plane that sits in front of every AI provider your organization uses (OpenAI, Anthropic, and more later), giving you real-time spend visibility, budget enforcement, governance policies, and cost-aware routing — through a single integration.

---

## Quick start

```bash
git clone <repo-url>
cd tokenistt

# Install dependencies
npm install

# Set up environment
cp apps/gateway/.env.example apps/gateway/.env
cp apps/dashboard/.env.example apps/dashboard/.env
# fill in DATABASE_URL, ENCRYPTION_KEY, provider sandbox keys

# Run migrations
npm run db:migrate --workspace=packages/db

# Start the gateway (proxy + API)
npm run dev --workspace=apps/gateway

# Start the dashboard (in a second terminal)
npm run dev --workspace=apps/dashboard
```

Once running, point any OpenAI-compatible client at `http://localhost:PORT/v1/chat/completions` with a Tokenistt-issued API key, and requests will start appearing in the dashboard.

---

## Repo structure

```
apps/
  landing/      ← public marketing site
  dashboard/    ← the product frontend (Next.js)
  gateway/      ← the backend — proxy, API, policy engine (Node.js + TypeScript)
packages/
  db/           ← Postgres schema, migrations, DB client
  shared-types/ ← TypeScript types shared between dashboard & gateway
infra/          ← Docker configs, deployment scripts
docs/           ← you are here
```

---

## Documentation index

| Doc | What's in it |
|---|---|
| [`PRD.md`](./PRD.md) | What we're building and why — vision, goals, non-goals, requirements |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | System design, database schema, request pipeline |
| [`API.md`](./API.md) | Full API endpoint reference |
| [`ROADMAP.md`](./ROADMAP.md) | Phase 1 / 2 / 3 sequencing and what's deferred |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Dev environment setup, conventions, PR checklist |

---

## Current scope (read this before adding a new module)

Tokenistt Phase 1 is intentionally narrow: two AI providers (OpenAI, Anthropic), a single Postgres database, no separate analytics pipeline, no ML-driven recommendations. See `ROADMAP.md` for the full list of what's deferred and why — check there before assuming a new database, queue, or service is needed for a feature.
