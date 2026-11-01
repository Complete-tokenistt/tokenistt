# Tokenistt — API Reference

The machine-readable reference is the OpenAPI 3.1 document served by the gateway at **`GET /v1/openapi.json`**. It is generated from the route table in `apps/gateway/src/openapi.ts`, and a test fails if a management route is missing from it. This page is an overview; when the two disagree, the OpenAPI document wins.

## Authentication

| Surface | Credential |
|---|---|
| Inference (`/v1/chat/completions`, `/v1/batch/…`, `/v1/logs`) | Virtual key: `Authorization: Bearer tktt_live_…` |
| Management (`/v1/admin/*`) | Operator: `X-Admin-Secret` + `?organization_id=`; or dashboard session JWT as `Authorization: Bearer …` (locked to the user's organization, limited by role) |
| Inbound connector webhooks | HMAC signature (or GitLab token) |
| `/health`, `/v1/models`, `/v1/providers`, `/v1/openapi.json` | None |
| `/metrics` | `METRICS_TOKEN` bearer, or private network in production |

Roles: `owner`, `admin`, `finance`, `developer`, `viewer`. See the permission matrix in the README.

## Inference

| Method | Path | Description |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible chat completion through the full pipeline. Supports `stream: true`. |
| POST | `/v1/batch/chat/completions` | Up to `BATCH_MAX_ITEMS` requests, each through the full pipeline. Body: `{ requests: [...] }`. |
| GET | `/v1/logs` | Request history for the calling key (cursor-paginated: `limit`, `before`, `status`). |
| GET | `/v1/models` | Supported models and whether a price is known. |
| GET | `/v1/providers` | Configured providers. |

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "authorization: Bearer tktt_live_…" -H 'content-type: application/json' \
  -H 'x-tokenistt-team: support' -H 'x-tokenistt-feature: triage' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

### Request headers

| Header | Effect |
|---|---|
| `x-provider` | Force a provider |
| `x-tokenistt-team`, `x-tokenistt-project` | Attribute to a team/project by slug, so their budgets apply |
| `x-tokenistt-repo`, `-ticket`, `-sprint`, `-feature`, `-customer`, `-employee`, `-environment` | Free-form attribution |
| `x-tokenistt-cache: true` | Serve identical temperature-0 requests from cache at zero cost (`always` ignores temperature) |
| `x-tokenistt-compress: true` | Collapse redundant whitespace and duplicate consecutive messages |

Responses carry the cost in the `x-tokenistt-cost` header and in `_tokenistt` in the body.

## Management (`/v1/admin/*`)

| Area | Endpoints |
|---|---|
| Budgets | `GET/POST /budgets`, `PATCH/DELETE /budgets/{id}` |
| Policies | `GET/POST /policies`, `PATCH/DELETE /policies/{id}` (effects: `allow`, `block`/`deny`, `force_model`, `require_approval`) |
| Approvals | `GET /approvals?status=`, `POST /approvals/{id}/approve`, `POST /approvals/{id}/deny` |
| Routing | `GET/POST /routing-rules`, `PATCH/DELETE /routing-rules/{id}`, `POST /routing-rules/simulate` (dry run), `GET /models` (catalog + observed cost/latency/error rate) |
| Virtual keys | `GET/POST /keys`, `DELETE /keys/{id}` (token shown once on create) |
| Provider keys (BYOK) | `GET/POST /provider-keys`, `PATCH/DELETE /provider-keys/{id}` (write-only secrets, `priority`) |
| Organization | `GET/POST /workspaces`, `/teams`, `/projects` |
| Alerts | `GET /alerts` |
| Audit | `GET /audit?kind=policy\|budget\|routing` |
| Connectors | `GET /connectors/types`, `GET/POST /connectors`, `POST /connectors/{id}/test`, `POST /connectors/{id}/sync`, `DELETE /connectors/{id}`, `GET /attribution?dimension=` |

All paths above are under `/v1/admin`. Every mutation is written to the append-only audit log. See the OpenAPI document for the complete, current list, including request bodies and required permissions.

Budget example:

```bash
curl -X POST $GW/v1/admin/budgets -H "x-admin-secret: $ADMIN" -H 'content-type: application/json' \
  -d '{"organization_id":1,"scope_type":"team","scope_id":4,"cap_usd":300,"enforcement_mode":"hard_cap"}'
```

## Webhooks

`POST /v1/webhooks/connectors/{id}` — inbound payloads for push-based connectors (CI/CD, custom webhook), authenticated by signature.

## Error format

Errors follow the OpenAI shape:

```json
{ "error": { "message": "…", "type": "…", "code": "budget_exceeded" } }
```

| `code` | Status | Meaning |
|---|---|---|
| `auth_failed` | 401 | Missing, invalid or revoked key |
| `invalid_request` | 400 | Malformed body |
| `policy_violation` | 403 | Blocked by a policy |
| `approval_required` | 403 | Held for approval; body includes `approval_id`. Retry after an admin approves |
| `budget_exceeded` | 429 | A `hard_cap` budget in scope is exhausted |
| `rate_limit_exceeded` | 429 | Virtual-key rate limit |
| provider errors | varies | `type: provider_error`, with the upstream `provider` and `code` |
