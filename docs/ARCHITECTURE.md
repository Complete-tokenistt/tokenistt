# Tokenistt — Architecture

## System overview

One gateway service, one database, for Phase 1. Not a distributed system — see `ROADMAP.md` for when (if ever) that changes.

```
Client app
    │  POST /v1/chat/completions
    ▼
┌─────────────────────────────────────────────┐
│         Gateway (Node.js + TypeScript)         │
│                                                   │
│  Auth → Policy → Budget → Routing →              │
│  BYOK key resolver → Provider adapter →           │
│  Streaming passthrough → Cost calculator →         │
│  Event logger (async, fail-open to file)            │
└─────────────────────────────────────────────┘
    │                              │
    ▼                              ▼
AI Provider                    Postgres
(OpenAI / Anthropic)           (single instance)
                                    │
                                    ▼
                              Dashboard API
                              (reads Postgres directly)
                                    │
                                    ▼
                              Dashboard (Next.js)
```

## Database schema

```sql
-- Identity
CREATE TABLE workspaces (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, plan TEXT DEFAULT 'closed_beta', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT UNIQUE NOT NULL, password_hash TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE workspace_members (workspace_id UUID REFERENCES workspaces(id), user_id UUID REFERENCES users(id), role TEXT CHECK (role IN ('owner','admin','member','billing')), team TEXT, status TEXT DEFAULT 'active', PRIMARY KEY (workspace_id, user_id));

-- Keys
CREATE TABLE api_keys (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID REFERENCES workspaces(id), key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, name TEXT, created_at TIMESTAMPTZ DEFAULT now(), revoked_at TIMESTAMPTZ);
CREATE TABLE provider_keys (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID REFERENCES workspaces(id), provider TEXT NOT NULL, encrypted_key BYTEA NOT NULL, label TEXT, status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT now(), rotated_at TIMESTAMPTZ);

-- Core event log
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) NOT NULL,
  team TEXT, project TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INT NOT NULL, output_tokens INT NOT NULL,
  cost_usd NUMERIC(12,6) NOT NULL, latency_ms INT, status TEXT NOT NULL,
  request_id TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_events_workspace_created ON events(workspace_id, created_at);
CREATE INDEX idx_events_team ON events(workspace_id, team, created_at);

-- Pricing (versioned — never mutate historical prices)
CREATE TABLE model_prices (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider TEXT NOT NULL, model TEXT NOT NULL, input_price_per_1k NUMERIC(10,6) NOT NULL, output_price_per_1k NUMERIC(10,6) NOT NULL, effective_from TIMESTAMPTZ NOT NULL, effective_to TIMESTAMPTZ);

-- Budgets
CREATE TABLE budgets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID REFERENCES workspaces(id), scope TEXT NOT NULL, scope_value TEXT, period TEXT NOT NULL, limit_usd NUMERIC(12,2) NOT NULL, alert_thresholds INT[] DEFAULT '{50,80,100}', enforcement TEXT DEFAULT 'soft', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE budget_alerts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), budget_id UUID REFERENCES budgets(id), threshold_pct INT, triggered_at TIMESTAMPTZ DEFAULT now(), action_taken TEXT);

-- Governance
CREATE TABLE policies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID REFERENCES workspaces(id), action TEXT NOT NULL, scope_team TEXT, model_pattern TEXT, environment TEXT, time_window TEXT, status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE policy_audit_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), policy_id UUID REFERENCES policies(id), event_id UUID REFERENCES events(id), decision TEXT, created_at TIMESTAMPTZ DEFAULT now());

-- Routing
CREATE TABLE routing_rules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID REFERENCES workspaces(id), name TEXT, priority INT NOT NULL, rule_type TEXT, scope_team TEXT, primary_model TEXT, fallback_models TEXT[], min_quality_pct INT, status TEXT DEFAULT 'active');
```

## Request pipeline

```typescript
async function handleChatCompletion(req: Request, res: Response) {
  const workspace = await validateApiKey(extractApiKey(req));           // 401 if invalid

  const policyResult = await evaluatePolicy(workspace, req.body);
  if (policyResult.action === 'deny') return res.status(403).json({ error: 'blocked by policy' });

  const budgetResult = await checkBudgets(workspace, req.body.team);
  if (budgetResult.hardBlocked) return res.status(429).json({ error: 'budget exceeded' });

  const routed = await resolveRouting(workspace, req.body, budgetResult);
  const adapter = getAdapter(routed.provider);
  let providerKey = await getActiveProviderKey(workspace, routed.provider);

  let response;
  const startTime = Date.now();
  try {
    response = await adapter.sendRequest({ ...req.body, model: routed.model, apiKey: providerKey });
  } catch (err) {
    if (isRateLimitError(err)) {
      providerKey = await failoverToNextKey(workspace, routed.provider);
      response = await adapter.sendRequest({ ...req.body, model: routed.model, apiKey: providerKey });
    } else {
      await logEvent({ workspace, routed, status: 'error' });
      throw err;
    }
  }

  const cost = calculateCost(routed.provider, routed.model, response.usage);
  logEvent({ workspace, routed, usage: response.usage, cost, latency: Date.now() - startTime, status: 'ok' })
    .catch(err => fallbackLogToFile(err));   // DB hiccup must never break the request

  return streamOrReturn(res, response);
}
```

## Provider adapter interface

The single most important abstraction — every provider added later implements this, and nothing else in the codebase should know provider-specific details.

```typescript
interface ProviderAdapter {
  sendRequest(params: {
    model: string;
    messages: { role: string; content: string }[];
    apiKey: string;
    stream?: boolean;
  }): Promise<{
    content: string;
    usage: { inputTokens: number; outputTokens: number };
    raw: unknown;
  }>;
}
```

## Design principles

1. **Events are immutable.** Never overwrite a logged event. Analytics are always derived from history, never mutate it.
2. **Fail open by default.** A gateway or DB hiccup should never silently break a customer's production traffic unless they've explicitly opted into hard enforcement.
3. **Provider-agnostic core.** No provider-specific logic outside the adapter layer.
4. **Analytics are SQL, not a service.** Aggregation queries against Postgres are correct for this stage — a separate analytics pipeline is a later-phase decision, made when a specific query is provably too slow, not before.
