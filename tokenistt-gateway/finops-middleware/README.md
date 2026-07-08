# FinOps Attribution Middleware

A comprehensive middleware for API gateways that handles virtual key authentication, cost center attribution, budget enforcement, and rate limiting.

## Features

- **Virtual Key Authentication**: Parse and validate `tktt_live_{workspace}_{user}_{hash}` tokens
- **Budget Enforcement**: Per-key budget limits with real-time tracking
- **Rate Limiting**: Configurable rate limits per virtual key (default: 100 req/min)
- **Cost Attribution**: Track usage by user, workspace, and cost center
- **Redis Backend**: Real-time counters with in-memory fallback
- **Express Integration**: Simple middleware pattern for any Express route

## Installation

```bash
npm install finops-middleware
```

## Quick Start

```typescript
import express from 'express';
import { createFinOpsMiddleware, createErrorHandler } from 'finops-middleware';

const app = express();
app.use(express.json());

// Create middleware with default config
const finOps = createFinOpsMiddleware({
  defaults: {
    rateLimitPerMinute: 100,
    budgetLimit: 100.00,
  },
});

// Apply to protected routes
app.use(finOps);
app.use(createErrorHandler());

app.post('/v1/chat/completions', (req, res) => {
  // req.attribution contains user context
  res.json({ message: 'Hello ' + req.attribution?.userId });
});

app.listen(3000);
```

## Token Format

Virtual keys use the format: `tktt_live_{workspace}_{user}_{hash}`

Example:
```
tktt_live_acme_jane_abc123def456
```

## API Endpoints

### Protected Endpoints

When using the middleware, the following headers are injected:

**Request Headers:**
- `Authorization: Bearer tktt_live_{workspace}_{user}_{hash}`

**Response Headers:**
- `X-Attribution-User`: User ID
- `X-Attribution-Cost-Center`: Cost center
- `X-Attribution-Workspace`: Workspace
- `X-Attribution-Virtual-Key`: Virtual key ID
- `X-RateLimit-Limit`: Rate limit per minute
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Unix timestamp when limit resets
- `X-Budget-Limit`: Budget limit
- `X-Budget-Remaining`: Remaining budget

### Error Responses

**Budget Exceeded (429):**
```json
{
  "error": "Budget exceeded",
  "code": "BUDGET_EXCEEDED",
  "limit": 50.00,
  "used": 48.50,
  "estimatedCost": 2.00
}
```

**Rate Limit Exceeded (429):**
```json
{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMIT_EXCEEDED",
  "limit": 100,
  "remaining": 0,
  "retryAfterSeconds": 60
}
```

**Invalid Token (401):**
```json
{
  "error": "Invalid or missing Authorization header",
  "code": "INVALID_TOKEN"
}
```

## Configuration

```typescript
const config: FinOpsConfig = {
  // Redis connection (optional)
  redis: {
    host: 'localhost',
    port: 6379,
    password: 'your-password', // optional
    db: 0,
    keyPrefix: 'finops:',
  },
  
  // Cache settings
  cache: {
    virtualKeyTtlSeconds: 60,
    rateLimitWindowSeconds: 60,
  },
  
  // Defaults for keys without explicit settings
  defaults: {
    rateLimitPerMinute: 100,
    budgetLimit: 100.00,
  },
  
  // Callbacks
  onBudgetExceeded: (context, result) => {
    console.log(`User ${context.userId} exceeded budget`);
  },
  onRateLimitExceeded: (context, result) => {
    console.log(`User ${context.userId} hit rate limit`);
  },
  onVirtualKeyNotFound: (token) => {
    console.log(`Unknown token: ${token}`);
  },
};
```

## Virtual Key Store

The middleware includes an in-memory virtual key store for development. For production, implement the `VirtualKeyStore` interface:

```typescript
import { VirtualKeyStore, VirtualKeyLookupResult } from 'finops-middleware';

class PostgresVirtualKeyStore implements VirtualKeyStore {
  async findByToken(token: string): Promise<VirtualKeyLookupResult | null> {
    // Query your database
    const result = await db.query(
      'SELECT * FROM virtual_keys WHERE api_key = $1 AND enabled = true',
      [token]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      virtualKeyId: row.id,
      realApiKey: row.api_key,
      userId: row.user_id,
      workspace: row.workspace,
      costCenter: row.cost_center,
      budgetLimit: row.budget_limit,
      budgetRemaining: row.budget_remaining,
      budgetResetAt: row.budget_reset_at,
      rateLimitPerMinute: row.rate_limit_per_minute,
      enabled: row.enabled,
    };
  }
}
```

## Demo Server

Run the demo server to test the middleware:

```bash
npm run dev
```

### Demo Virtual Keys

| Token | Budget | Cost Center |
|-------|--------|-------------|
| `tktt_live_acme_jane_abc123def456` | $87.50 | engineering |
| `tktt_live_acme_john_xyz789uvw012` | $12.30 | marketing |
| `tktt_live_globex_alice_qrs456tuv789` | $450.00 | research |
| `tktt_live_acme_disabled_mno321pqr654` | (disabled) | deprecated |

### Example Requests

```bash
# Health check
curl http://localhost:3001/health

# Budget status (requires auth)
curl -H "Authorization: Bearer tktt_live_acme_jane_abc123def456" \
     http://localhost:3001/v1/budget

# AI endpoint (requires auth)
curl -X POST -H "Authorization: Bearer tktt_live_acme_jane_abc123def456" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-3-sonnet","messages":[{"role":"user","content":"Hello"}]}' \
     http://localhost:3001/v1/chat/completions

# Cost estimation
curl -X POST -H "Content-Type: application/json" \
     -d '{"messages":[{"content":"Hello world"}],"max_tokens":100}' \
     http://localhost:3001/v1/estimate-cost
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Client Request                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    FinOps Middleware                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ Token Parser    │──▶│ Virtual Key     │──▶│ Rate Limiter   │ │
│  │                 │  │ Lookup          │  │                 │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│                              │                    │              │
│                              ▼                    ▼              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ Budget Checker  │──▶│ Header Injection│  │ Response        │ │
│  │                 │  │                 │  │ Interceptor     │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Your API Route                                 │
│  req.attribution = { userId, workspace, costCenter, ... }      │
└─────────────────────────────────────────────────────────────────┘
```

## License

MIT
