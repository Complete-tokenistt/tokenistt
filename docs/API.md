# Tokenistt — API Reference

All endpoints are prefixed `/v1`. Authenticated endpoints require an API key issued via `/v1/api-keys`, sent as `Authorization: Bearer <key>`.

## Auth

| Method | Path | Description |
|---|---|---|
| POST | `/auth/signup` | Create a user and their first workspace |
| POST | `/auth/login` | Authenticate, returns a session token |
| POST | `/auth/logout` | Invalidate the current session |
| GET | `/auth/me` | Current user + workspace context |

## Workspace

| Method | Path | Description |
|---|---|---|
| GET | `/workspace` | Workspace details |
| PATCH | `/workspace` | Update workspace name/settings |
| GET | `/workspace/members` | List members and roles |
| POST | `/workspace/members/invite` | Invite a member by email |

## Gateway (the core product)

| Method | Path | Description |
|---|---|---|
| POST | `/chat/completions` | OpenAI-compatible proxy endpoint. Forwards to the resolved provider/model after auth, policy, and budget checks. Streams response through unmodified. |

**Example request:**
```json
POST /v1/chat/completions
Authorization: Bearer sk-tok-xxxx

{
  "model": "gpt-4o-mini",
  "messages": [{ "role": "user", "content": "Hello" }],
  "team": "support-ai",
  "project": "zendesk-triage",
  "stream": true
}
```

## Providers & BYOK

| Method | Path | Description |
|---|---|---|
| GET | `/providers` | List connected providers and status |
| POST | `/providers/:provider/keys` | Add a BYOK key |
| DELETE | `/providers/:provider/keys/:id` | Revoke a key |
| POST | `/providers/:provider/keys/:id/rotate` | Rotate a key |

## API Keys (issued to customer apps — opposite direction from above)

| Method | Path | Description |
|---|---|---|
| GET | `/api-keys` | List issued keys |
| POST | `/api-keys` | Create a new key |
| DELETE | `/api-keys/:id` | Revoke a key |

## Usage

| Method | Path | Description |
|---|---|---|
| GET | `/events` | Filterable request log — `?team=&provider=&model=&from=&to=&status=` |
| GET | `/events/:id` | Full metadata for a single request |

## Spend / Analytics

| Method | Path | Description |
|---|---|---|
| GET | `/spend/overview` | MTD spend, budget utilization, forecast |
| GET | `/spend/by-team` | Spend grouped by team — `?range=30d` |
| GET | `/spend/timeseries` | Spend over time — `?interval=day` |

## Budgets

| Method | Path | Description |
|---|---|---|
| GET | `/budgets` | List budgets |
| POST | `/budgets` | Create a budget |
| PATCH | `/budgets/:id` | Update scope/limit/enforcement |
| DELETE | `/budgets/:id` | Remove a budget |
| GET | `/budgets/:id/alerts` | Alert history for a budget |

## Governance

| Method | Path | Description |
|---|---|---|
| GET | `/policies` | List active policies |
| POST | `/policies` | Create a policy |
| PATCH | `/policies/:id` | Update a policy |
| DELETE | `/policies/:id` | Remove a policy |
| GET | `/policies/audit-log` | Every allow/deny decision made |

## Routing

| Method | Path | Description |
|---|---|---|
| GET | `/routing/rules` | List routing rules, in priority order |
| POST | `/routing/rules` | Create a rule |
| PATCH | `/routing/rules/:id` | Update a rule |
| POST | `/routing/simulate` | Test a sample request against active rules without executing it |

## Error format

All errors follow the same shape:
```json
{ "error": "budget exceeded", "code": "BUDGET_HARD_LIMIT", "details": { "budget_id": "..." } }
```
