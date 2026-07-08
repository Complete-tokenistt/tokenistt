<div align="center">

# 🔐 Tokenistt

### AI Cost Visibility · Governance · Budget Control · Multi-Provider Routing

**One Integration. Complete Control.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://typescriptlang.org)
[![Next.js](https://img.shields.io/badge/Next.js-15.5-black.svg)](https://nextjs.org)

> Drop-in OpenAI SDK replacement with FinOps-grade cost tracking, virtual key management, budget enforcement, and intelligent multi-provider routing — across Anthropic, AWS Bedrock, and Azure OpenAI.

</div>

---

## Table of Contents

- [What is Tokenistt?](#what-is-tokenistt)
- [Architecture](#architecture)
- [Repository Structure](#repository-structure)
- [Quick Start](#quick-start)
- [Services](#services)
  - [Universal Gateway](#1-universal-gateway)
  - [FinOps Middleware](#2-finops-middleware)
  - [Tokenistt SDK (Node.js)](#3-tokenistt-sdk-nodejs)
  - [Python SDK](#4-python-sdk)
  - [Dashboard](#5-dashboard-nextjs)
  - [Analytics Consumer](#6-analytics-consumer)
  - [Credential Manager](#7-credential-manager)
  - [MCP Server](#8-mcp-server)
  - [Shadow-AI Scanner](#9-shadow-ai-scanner)
- [Database](#database)
- [Environment Variables](#environment-variables)
- [npm Scripts](#npm-scripts)
- [Development Guide](#development-guide)
- [Roadmap](#roadmap)
- [License](#license)

---

## What is Tokenistt?

Tokenistt solves a real problem for engineering teams using LLMs at scale: **you have no idea what your AI is costing, who is spending it, or why.**

Tokenistt sits between your code and the LLM providers. Every request flows through a single gateway that:

- ✅ **Authenticates** requests using virtual keys scoped to workspaces and users
- ✅ **Enforces budgets** before the request is sent — not after the invoice arrives
- ✅ **Calculates exact cost** per request using live token pricing
- ✅ **Attributes spend** to users, teams, cost centers, and projects
- ✅ **Routes intelligently** across Anthropic, AWS Bedrock, and Azure OpenAI
- ✅ **Tracks everything** in an immutable Postgres ledger for audits and forecasting

Your existing OpenAI code needs **one import change**:

```typescript
// Before
import OpenAI from 'openai';

// After — everything else stays identical
import Tokenistt from '@tokenistt/sdk';
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         DEVELOPERS                              │
│  VS Code · Windsurf · CLI · AI Agents                          │
│  Install @tokenistt/sdk  ·  Add virtual API key                │
└──────────────────────────┬──────────────────────────────────────┘
                           │ AI Request (Prompt + Params)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│              TOKENISTT GATEWAY (Node.js + TypeScript)           │
│                                                                 │
│  1. Authentication      →  Validate virtual key → workspace     │
│  2. Workspace Resolver  →  Identify team, user, cost-center     │
│  3. Governance          →  Allow / Deny pre-flight check        │
│  4. Budget Engine       →  Soft warn / Throttle / Hard block    │
│  5. Routing Engine      →  Cheapest / Fastest / Policy          │
│  6. BYOK Key Resolver   →  Select real provider key             │
│  7. Provider Adapters   →  Anthropic / Bedrock / Azure          │
│  8. Streaming           →  Zero-buffer SSE passthrough          │
│  9. Cost Calculator     →  Tokens → exact USD cost              │
│ 10. Event Logger        →  Async write to Postgres              │
└──────────────┬──────────────────────────┬───────────────────────┘
               │                          │
               ▼                          ▼
┌──────────────────────┐      ┌───────────────────────────────────┐
│    LLM PROVIDERS     │      │           STORAGE                 │
│                      │      │                                   │
│  • Anthropic Claude  │      │  PostgreSQL  — transactions,      │
│  • AWS Bedrock       │      │  budgets, workspaces, audit logs  │
│  • Azure OpenAI      │      │                                   │
│  • OpenAI direct     │      │  Redis       — rate-limit cache   │
└──────────────────────┘      │  ClickHouse  — analytics OLAP     │
                              └───────────────────────────────────┘
                                           │
                                           ▼
                              ┌───────────────────────────────────┐
                              │     DASHBOARD (Next.js)           │
                              │                                   │
                              │  Overview · Budgets · Teams       │
                              │  Providers · Shadow-AI · Alerts   │
                              └───────────────────────────────────┘
```

---

## Repository Structure

```
tokenistt/                              ← Monorepo root (npm workspaces)
│
├── tokenistt-gateway/                  ← Phase 1: Gateway services
│   ├── universal-gateway/              ← Multi-provider AI proxy (Express + TypeScript)
│   │   └── src/
│   │       ├── server.ts               ← Express app entry
│   │       ├── providers/              ← Anthropic, Bedrock, Azure adapters
│   │       └── services/              ← GatewayService, pricing calculator
│   │
│   ├── finops-middleware/              ← FinOps attribution middleware
│   │   └── src/
│   │       ├── middleware/finops.ts    ← Auth + budget + attribution pipeline
│   │       ├── services/budget.ts     ← Budget reserve / check / release
│   │       ├── services/virtualKey.ts ← Virtual key lookup + resolution
│   │       └── services/rateLimiter.ts← Per-key rate limiting (Redis)
│   │
│   └── tokenist-sdk/                  ← @tokenist/sdk v1 (prototype)
│
├── tokenistt-sdk/                     ← Phase 2+: Production SDK & platform
│   ├── src/                           ← @tokenistt/sdk v2 (production)
│   │   ├── client.ts                  ← Main Tokenistt client class
│   │   ├── core/                      ← cost.ts, emitter.ts, fetch.ts, stream.ts
│   │   ├── resources/                 ← chat.ts, embeddings.ts, models.ts
│   │   └── types.ts                   ← Full TypeScript type definitions
│   │
│   ├── python/                        ← Python SDK (async-native)
│   │   └── tokenistt/
│   │       ├── client.py              ← Sync client
│   │       ├── async_client.py        ← Async client
│   │       └── core/                  ← cost, events, stream
│   │
│   ├── db/                            ← Database layer
│   │   ├── drizzle/
│   │   │   ├── 0000_init.sql          ← Authoritative DDL (tables, indexes, partitions)
│   │   │   ├── views.sql              ← Materialized views for analytics rollups
│   │   │   ├── queries.sql            ← Sample FinOps queries
│   │   │   └── schema.ts              ← Drizzle typed ORM model
│   │   └── prisma/schema.prisma       ← Prisma alternative schema
│   │
│   ├── analytics/                     ← Real-time analytics pipeline
│   │   ├── consumer/                  ← Kafka → ClickHouse consumer (Node.js)
│   │   └── clickhouse/                ← ClickHouse schema + queries
│   │
│   ├── examples/quickstart.ts         ← SDK usage examples
│   │
│   └── home/user/                     ← Extended platform tools
│       ├── dashboard/                 ← Next.js 15 CFO spend dashboard
│       │   ├── app/                   ← App Router pages
│       │   └── components/            ← Charts, tables, budget bars
│       ├── credential-manager/        ← BYOK key store (local/Vault/KMS)
│       ├── mcp-server/                ← Model Context Protocol server
│       └── shadow-ai-scanner/         ← Detect unauthorized AI spend
│
├── package.json                       ← Root npm workspaces config
├── .npmrc                             ← audit-level=high
├── .gitignore
└── README.md
```

---

## Quick Start

### Prerequisites

| Requirement | Version |
|---|---|
| Node.js | >= 18 |
| npm | >= 9 |
| Docker (optional) | For Postgres, Redis, Kafka, ClickHouse |

### 1. Clone and install

```bash
git clone https://github.com/Complete-tokenistt/tokenist-main.git
cd tokenist-main

# Install all workspace dependencies in one shot
npm install
```

### 2. Set up the Gateway (minimum: 1 AI key)

```bash
cp tokenistt-gateway/home/user/universal-gateway/.env.example \
   tokenistt-gateway/home/user/universal-gateway/.env

# Edit and add your Anthropic key (or AWS/Azure)
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

### 3. Start the core services

```bash
# Terminal 1 — Universal Gateway (port 3000)
npm run dev:gateway

# Terminal 2 — FinOps Middleware (port 3001)
npm run dev:middleware

# Terminal 3 — Dashboard UI (port 3000 — next.js)
cd tokenistt-sdk/home/user/dashboard && npm run dev
```

### 4. Make your first request

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tktt_live_acme_alice_abc123" \
  -d '{
    "model": "claude-3-sonnet",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```

---

## Services

### 1. Universal Gateway

> `tokenistt-gateway/universal-gateway/` · Port `3000`

The core HTTP proxy that normalises requests across AI providers and returns OpenAI-compatible responses regardless of which provider handles the call.

**Provider Adapters built:**

| Provider | Models | File |
|---|---|---|
| Anthropic | Claude 3 (Opus, Sonnet, Haiku) | `src/providers/anthropic.ts` |
| AWS Bedrock | Claude via Bedrock, Titan | `src/providers/bedrock.ts` |
| Azure OpenAI | GPT-4, GPT-3.5 | `src/providers/azure.ts` |
| OpenAI direct | GPT-4o, GPT-3.5-turbo, o1, o3 | `src/providers/openai.ts` |

**Key capabilities:**
- Automatic provider detection from model name (e.g. `claude-*` → Anthropic)
- Per-request `X-Provider` header override
- Exact cost calculation after every response (`pricing.ts`)
- Latency tracking, request ID generation
- OpenAI-compatible response envelope (`choices`, `usage`, `model`)

**Start:**
```bash
npm run dev:gateway
# or from within the package:
cd tokenistt-gateway/universal-gateway && npm run dev
```

**Environment:**
```env
PORT=3000
ANTHROPIC_API_KEY=sk-ant-xxxxx
AWS_ACCESS_KEY_ID=AKIAxxxxx
AWS_SECRET_ACCESS_KEY=xxxxx
AWS_REGION=us-east-1
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=xxxxx
AZURE_DEPLOYMENT_NAME=gpt-4
DEFAULT_PROVIDER=anthropic
```

---

### 2. FinOps Middleware

> `tokenistt-gateway/finops-middleware/` · Port `3001`

Express middleware that sits in front of the gateway and enforces the full FinOps pipeline: authentication → workspace resolution → rate limiting → budget check → attribution injection.

**Pipeline (per request):**

```
Authorization: Bearer tktt_live_{workspace}_{user}_{hash}
        │
        ▼
  parseVirtualKeyToken()   →  extract workspace + userId
        │
        ▼
  virtualKeyService.lookup()  →  resolve real API key + budget limits
        │
        ▼
  rateLimiterService.checkRateLimit()  →  429 if exceeded
        │
        ▼
  budgetService.checkBudget()  →  429 if budget hard limit hit
        │
        ▼
  budgetService.reserveBudget()  →  optimistic reservation
        │
        ▼
  req.attribution = { userId, workspace, costCenter, realApiKey }
        │
        ▼
  [forward to Universal Gateway]
        │
        ▼
  res.json() intercepted → recordCost() + releaseBudget() reconciliation
```

**Services:**
- `virtualKey.ts` — in-memory key store (Postgres-backed in production)
- `budget.ts` — reserve/check/release/record with Redis counters
- `rateLimiter.ts` — sliding window rate limiting per virtual key

**Start:**
```bash
npm run dev:middleware
# or:
cd tokenistt-gateway/finops-middleware && npm run dev
```

---

### 3. Tokenistt SDK (Node.js)

> `tokenistt-sdk/` · npm package `@tokenistt/sdk`

Production-grade drop-in OpenAI replacement with full FinOps instrumentation built in.

**Install in your project:**
```bash
npm install @tokenistt/sdk
```

**Basic usage:**
```typescript
import Tokenistt from '@tokenistt/sdk';

const client = new Tokenistt({
  apiKey: process.env.TOKENISTT_API_KEY,
  baseURL: 'http://localhost:3000/v1',
});

const response = await client.chat.completions.create({
  model: 'claude-3-sonnet',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
console.log(`Cost: $${response.actual_cost}`);
console.log(`Provider: ${response.provider}`);
```

**Budget control:**
```typescript
const client = new Tokenistt({
  apiKey: process.env.TOKENISTT_API_KEY,
  budget: { softLimit: 10, hardLimit: 25 },
  onUsage: (cost) => console.log(`$${cost.toFixed(6)}`),
});

client.on('budget:warning', (e) => console.warn('Approaching budget', e));
client.on('budget:exceeded', (e) => console.error('Budget exceeded', e));
```

**User attribution:**
```typescript
const client = new Tokenistt({
  apiKey: 'your-virtual-key',
  user: 'alice@company.com',
  costCenter: 'engineering',
});
```

**Streaming:**
```typescript
const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Count to 5.' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

**All supported resources:**
- `client.chat.completions.create()` — chat completions (streaming + non-streaming)
- `client.embeddings.create()` — text embeddings
- `client.models.list()` / `.retrieve()` / `.del()`
- `client.moderations.create()` — content moderation
- `client.completions.create()` — legacy completions

**Build:**
```bash
npm run build:sdk:v2
# Output: tokenistt-sdk/dist/
```

---

### 4. Python SDK

> `tokenistt-sdk/python/` · pip package `tokenistt`

Async-native Python SDK that mirrors the Node.js API surface.

**Install:**
```bash
pip install tokenistt
```

**Sync usage:**
```python
from tokenistt import Tokenistt

client = Tokenistt(
    api_key="your-virtual-key",
    base_url="http://localhost:3000/v1",
)

response = client.chat.completions.create(
    model="claude-3-sonnet",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

**Async usage:**
```python
from tokenistt import AsyncTokenistt

async def main():
    client = AsyncTokenistt(api_key="your-virtual-key")
    response = await client.chat.completions.create(
        model="claude-3-sonnet",
        messages=[{"role": "user", "content": "Hello!"}],
    )
    print(response.choices[0].message.content)
```

---

### 5. Dashboard (Next.js)

> `tokenistt-sdk/home/user/dashboard/` · Port `3000` (Next.js dev server)

A CFO-ready spend analytics dashboard built with Next.js 15, React 19, Recharts 3, and Tailwind CSS.

**Pages:**

| Route | Description |
|---|---|
| `/` | Overview — summary cards, provider pie chart, spend timeline |
| `/team` | Per-member model spend (stacked bar chart) |
| `/cost-centers` | Budget utilization bars per cost center |
| `/providers` | Provider breakdown + reconciliation |
| `/benchmark` | Live model benchmarking (speed, cost, quality) |
| `/shadow-ai` | Shadow AI findings from the scanner |
| `/reconciliation` | Upload vendor invoices and reconcile vs ledger |

**Start:**
```bash
cd tokenistt-sdk/home/user/dashboard
npm run dev
# http://localhost:3000

# Build for production
npm run build && npm start
```

**Environment (`dashboard/.env.local`):**
```env
# Optional — dashboard runs with mock data if blank
TOKENISTT_BASE_URL=http://localhost:3000/v1
TOKENISTT_API_KEY=tktt_live_acme_dashboard_xxx
```

> **Works with zero config.** All pages use realistic mock data out of the box — connect to the real gateway when ready.

---

### 6. Analytics Consumer

> `tokenistt-sdk/analytics/consumer/` · Kafka → ClickHouse pipeline

Consumes transaction events from Kafka and batch-inserts them into ClickHouse for OLAP analytics (spend by provider, team, model, anomaly detection).

**Start (requires Docker):**
```bash
# Start infrastructure
docker-compose -f tokenistt-sdk/analytics/docker-compose.yml up -d
# Starts: Kafka, Zookeeper, ClickHouse

# Run consumer
cd tokenistt-sdk/analytics/consumer && npm run start
```

**Environment (`analytics/.env`):**
```env
KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC=transactions
KAFKA_GROUP=tokenistt-analytics
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=default
BATCH_SIZE=5000
FLUSH_MS=2000
```

---

### 7. Credential Manager

> `tokenistt-sdk/home/user/credential-manager/` · Port `4000`

Secure BYOK (Bring Your Own Key) credential store. Stores and retrieves real provider API keys that the gateway uses to make upstream calls.

**Backends:**

| Backend | Use case | Config |
|---|---|---|
| `local` | Development only | `MASTER_KEY=any-32-char-string` |
| `vault` | Production (HashiCorp Vault) | `VAULT_ADDR` + `VAULT_TOKEN` |
| `kms` | Production (AWS KMS) | `AWS_REGION` + `AWS_KMS_KEY_ARN_PREFIX` |

**Start:**
```bash
cd tokenistt-sdk/home/user/credential-manager
CRED_BACKEND=local MASTER_KEY=dev-secret-key-change-in-prod npm run dev
```

---

### 8. MCP Server

> `tokenistt-sdk/home/user/mcp-server/` · Port `3001` (SSE) or stdio

[Model Context Protocol](https://modelcontextprotocol.io) server that exposes Tokenistt tools to AI agents and MCP-compatible clients (Claude Desktop, Cursor, Windsurf).

**Tools exposed:**
- `route_request` — intelligently route an LLM call to the best provider
- `get_spend` — query current spend for a user or cost center
- `optimize_prompt` — suggest cheaper model alternatives
- `list_models` — list available models with pricing

**Transports:**
```bash
# stdio (for Claude Desktop / Cursor)
MCP_TRANSPORT=stdio npm run start

# SSE (for web clients)
MCP_TRANSPORT=sse PORT=3001 npm run start
```

---

### 9. Shadow-AI Scanner

> `tokenistt-sdk/home/user/shadow-ai-scanner/`

Detects unauthorized AI spend by scanning corporate expense platforms (Brex, Ramp) for AI vendor charges that didn't flow through the approved Tokenistt gateway. Runs on a cron schedule, flags anomalies, and POSTs findings to the dashboard.

**How it works:**
1. Reads expense transactions from Brex / Ramp via OAuth
2. Matches vendor names against known AI provider patterns (OpenAI, Anthropic, etc.)
3. Cross-checks against the Tokenistt gateway's approved transaction ledger
4. Flags any AI expense without a matching gateway transaction as **Shadow AI**
5. POSTs findings to `DASHBOARD_URL/api/shadow-ai/scan`

**Start:**
```bash
cd tokenistt-sdk/home/user/shadow-ai-scanner
npm run start
```

**Environment:**
```env
REDIS_URL=redis://localhost:6379
SCAN_CRON=0 6 * * *
SCANNER_ORGS=[{"orgId":"acme","providers":["brex"],"users":[...]}]
BREX_CLIENT_ID=your-brex-app-id
BREX_CLIENT_SECRET=your-brex-app-secret
```

---

## Database

The Postgres schema lives in `tokenistt-sdk/db/drizzle/`.

### Apply schema

```bash
# Apply DDL to your Postgres instance
psql $DATABASE_URL -f tokenistt-sdk/db/drizzle/0000_init.sql
psql $DATABASE_URL -f tokenistt-sdk/db/drizzle/views.sql
```

### Core tables

| Table | Purpose |
|---|---|
| `organizations` | Multi-tenant orgs |
| `workspaces` | Teams / cost centers within an org |
| `users` | Individual actors |
| `virtual_keys` | API keys with budget caps |
| `transactions` | **One row per API call** — immutable FinOps ledger |
| `provider_invoices` | Vendor bills for reconciliation |

### Key design decisions

- **`cost_usd` is `numeric(18,6)`** — exact decimal, never float. Required for financial audits.
- **`transactions` is monthly-partitioned** — partition pruning makes time-range queries 10–100x faster at scale.
- **Denormalized `cost_center` + `actor`** on every transaction row — no joins needed for the two most common FinOps queries.
- **Materialized views** refresh every 15 minutes via `pg_cron`: `mv_cost_by_provider_daily`, `mv_cost_by_cost_center_daily`, `mv_virtual_key_spend_monthly`.

### Drizzle typed model

```typescript
import { db } from './db/drizzle/schema';

// Query Sarah's spend last week
const spend = await db
  .select({ total: sum(transactions.cost_usd) })
  .from(transactions)
  .where(and(
    eq(transactions.actor, 'sarah@acme.io'),
    eq(transactions.cost_center, 'CC-4401-Support'),
    gte(transactions.created_at, lastWeek)
  ));
```

---

## Environment Variables

### Minimum to run locally

```env
# tokenistt-gateway/home/user/universal-gateway/.env
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

### Full reference

| Service | File | Key Variables |
|---|---|---|
| Universal Gateway | `universal-gateway/.env` | `ANTHROPIC_API_KEY`, `AWS_*`, `AZURE_*` |
| FinOps Middleware | `finops-middleware/.env` | `PORT=3001`, `NODE_ENV` |
| Dashboard | `dashboard/.env.local` | `TOKENISTT_BASE_URL`, `TOKENISTT_API_KEY` (both optional) |
| Analytics | `analytics/.env` | `KAFKA_BROKERS`, `CLICKHOUSE_URL` |
| Credential Manager | `credential-manager/.env` | `CRED_BACKEND`, `MASTER_KEY` |
| MCP Server | `mcp-server/.env` | `MCP_TRANSPORT`, `GATEWAY_URL` (optional) |
| Shadow-AI Scanner | `shadow-ai-scanner/.env` | `REDIS_URL`, `SCANNER_ORGS`, Brex/Ramp OAuth |

> See [env_reference.md](docs/env_reference.md) for every variable with descriptions.

---

## npm Scripts

Run from the **monorepo root**:

```bash
# ── Dev servers ──────────────────────────────
npm run dev:gateway        # Universal Gateway on :3000
npm run dev:middleware     # FinOps Middleware on :3001

# ── Builds ───────────────────────────────────
npm run build:all          # Build every package
npm run build:gateway      # Build universal-gateway
npm run build:middleware   # Build finops-middleware
npm run build:sdk:v1       # Build @tokenist/sdk (v1)
npm run build:sdk:v2       # Build @tokenistt/sdk (v2)

# ── Type checking ─────────────────────────────
npm run typecheck:gateway
npm run typecheck:middleware
npm run typecheck:sdk

# ── Audit ────────────────────────────────────
npm audit                  # Check vulnerabilities (level: high+)
```

---

## Development Guide

### Adding a new LLM provider

1. Create `tokenistt-gateway/universal-gateway/src/providers/myprovider.ts`
2. Extend `BaseProviderAdapter` and implement `translateRequest()`, `callProvider()`, `parseResponse()`
3. Register in `providers/registry.ts`
4. Add env vars to `.env.example`

### Adding a new dashboard page

1. Create `tokenistt-sdk/home/user/dashboard/app/my-page/page.tsx`
2. Add a route to `components/DashboardShell.tsx` nav
3. Create a matching API route at `app/api/my-page/route.ts`

### Running tests

```bash
# SDK tests
cd tokenistt-sdk && npm test

# Gateway tests
cd tokenistt-gateway/universal-gateway && npm test

# Middleware tests
cd tokenistt-gateway/finops-middleware && npm test
```

---

## Roadmap

### ✅ Phase 1 — Core (Built)
- [x] Universal Gateway (Anthropic, Bedrock, Azure)
- [x] FinOps Middleware (virtual keys, budgets, rate limiting)
- [x] `@tokenistt/sdk` Node.js v2
- [x] Python SDK
- [x] Postgres schema (partitioned, materialized views)
- [x] Next.js Dashboard (Overview, Teams, Budgets, Providers)
- [x] MCP Server (stdio + SSE)
- [x] Shadow-AI Scanner (Brex, Ramp)
- [x] Analytics Consumer (Kafka → ClickHouse)

### 🔧 Phase 1 — Gaps to close
- [x] Wire finops-middleware → universal-gateway into one pipeline
- [x] Event Logger — write `transactions` row per API call to Postgres
- [x] Connect Dashboard APIs to real Postgres data (remove mock)
- [x] OpenAI direct provider adapter
- [ ] Server-side streaming (SSE passthrough in gateway)
- [ ] Dashboard pages: Governance, Routing Rules, Alerts, Settings

### 🚀 Phase 2 — Coming
- [ ] Connectors (GitHub, Jira, Slack, Linear)
- [ ] Feature / Repository / Sprint / Customer cost attribution
- [ ] Cost-optimized routing engine (cheapest/fastest decisions)
- [ ] Additional providers: Groq, Google Gemini, Together AI, Ollama
- [ ] Spend forecasting (time-series ML)
- [ ] Policy engine (allow/deny rules per model, user, cost center)
- [ ] Redis-backed virtual key store (replace in-memory)
- [ ] Object storage (exports, audit backups)

---

## License

MIT © Tokenistt

---

<div align="center">
  <sub>Built for engineering teams who want to ship AI responsibly.</sub>
</div>