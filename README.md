# Tokenistt — Monorepo

A unified monorepo for the **Tokenistt** platform — a drop-in OpenAI SDK replacement with FinOps-grade cost tracking, budget control, and multi-provider AI routing.

---

## Repository Structure

```
tokenistt/
├── tokenistt-gateway/           # Phase 1: Core services (v1 SDK + gateway + middleware)
│   ├── universal-gateway/       # Multi-provider AI Gateway (OpenAI, Anthropic, Bedrock, Azure)
│   ├── finops-middleware/       # FinOps Attribution Middleware (virtual keys, budgets, rate-limits)
│   └── tokenist-sdk/            # @tokenist/sdk v1 — prototype SDK
│
├── tokenistt-sdk/               # Phase 2+: Production SDK & extended platform
│   ├── src/                     # @tokenistt/sdk v2 — production drop-in OpenAI replacement
│   ├── python/                  # Python SDK (async-native, mirrors Node API)
│   ├── db/                      # Postgres schema (Drizzle + Prisma), FinOps ledger
│   ├── analytics/               # ClickHouse consumer + Kafka pipeline
│   ├── examples/                # Quickstart examples
│   └── home/user/               # Extended platform tools
│       ├── dashboard/           # Next.js spend dashboard
│       ├── credential-manager/  # Secret-store backed credential manager
│       ├── mcp-server/          # Model Context Protocol server
│       └── shadow-ai-scanner/   # Shadow-AI detection scanner
│
├── package.json                 # Root npm workspaces config
├── .gitignore
└── README.md
```

---

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9 (for workspaces)

### Install all dependencies

Run once from the root — npm workspaces will hoist shared dependencies:

```bash
npm install
```

---

## Running the Services

### Universal Gateway (multi-provider AI proxy)

```bash
npm run dev:gateway
# Starts on http://localhost:3000
```

### FinOps Middleware (virtual keys + budget enforcement)

```bash
npm run dev:middleware
# Starts on http://localhost:4000
```

---

## Building

```bash
# Build everything
npm run build:all

# Build individual packages
npm run build:gateway
npm run build:middleware
npm run build:sdk:v1
npm run build:sdk:v2
```

---

## Package Overview

| Package | Location | Description |
|---------|----------|-------------|
| `universal-gateway` | `tokenistt-gateway/universal-gateway` | Multi-provider AI gateway (Express, Anthropic, Bedrock, Azure) |
| `finops-middleware` | `tokenistt-gateway/finops-middleware` | Virtual key management, budget enforcement, rate limiting |
| `@tokenist/sdk` (v1) | `tokenistt-gateway/tokenist-sdk` | Prototype drop-in OpenAI SDK replacement |
| `@tokenistt/sdk` (v2) | `tokenistt-sdk` | Production SDK — auto-retry, cost tracking, per-user attribution |
| `analytics-consumer` | `tokenistt-sdk/analytics/consumer` | Kafka consumer → ClickHouse pipeline |
| `dashboard` | `tokenistt-sdk/home/user/dashboard` | Next.js spend analytics dashboard |
| `credential-manager` | `tokenistt-sdk/home/user/credential-manager` | Secret-backend credential management |
| `mcp-server` | `tokenistt-sdk/home/user/mcp-server` | MCP server for AI tooling |
| `shadow-ai-scanner` | `tokenistt-sdk/home/user/shadow-ai-scanner` | Shadow AI usage detection |

---

## SDK Quick Start

### Node.js (`@tokenistt/sdk`)

```typescript
import Tokenistt from '@tokenistt/sdk';

const client = new Tokenistt({
  apiKey: process.env.TOKENISTT_API_KEY,
  baseURL: 'http://localhost:3000/v1',
  budget: { softLimit: 10, hardLimit: 25 },
  onUsage: (cost) => console.log(`$${cost.toFixed(6)}`),
});

const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
```

---

## License

MIT
