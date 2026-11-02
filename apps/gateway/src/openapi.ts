/**
 * openapi.ts — OpenAPI 3.1 description of the gateway, served at GET /v1/openapi.json.
 *
 * The spec is built from the route table below. A test walks the Express management router
 * and fails if a registered route is missing here, so the document cannot silently drift.
 */

interface RouteDoc {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;                 // OpenAPI style: /v1/admin/budgets/{id}
  summary: string;
  tag: string;
  auth: 'none' | 'virtualKey' | 'admin' | 'signature';
  permission?: string;
  body?: string;                // short description of the JSON body
  query?: string[];
}

const ADMIN = 'admin' as const;

export const ROUTES: RouteDoc[] = [
  // ── Inference (virtual key) ────────────────────────────────────────────────
  { method: 'post', path: '/v1/chat/completions', tag: 'Inference', auth: 'virtualKey', summary: 'OpenAI-compatible chat completion through the full pipeline (auth, policy, budgets, routing, cost, logging). Supports stream:true. Optional headers: x-provider, x-tokenistt-{team,project,environment,repo,ticket,sprint,feature,customer,employee}, x-tokenistt-cache, x-tokenistt-compress.' },
  { method: 'post', path: '/v1/batch/chat/completions', tag: 'Inference', auth: 'virtualKey', summary: 'Run up to BATCH_MAX_ITEMS chat completions; each goes through the full pipeline.', body: '{ requests: ChatCompletionRequest[] }' },
  { method: 'get', path: '/v1/models', tag: 'Inference', auth: 'none', summary: 'List supported models and pricing availability.' },
  { method: 'get', path: '/v1/providers', tag: 'Inference', auth: 'none', summary: 'Configured providers.' },
  { method: 'get', path: '/v1/logs', tag: 'Inference', auth: 'virtualKey', summary: 'Request history for the calling virtual key (cursor-paginated).', query: ['limit', 'before', 'status'] },
  { method: 'get', path: '/v1/usage/me', tag: 'Inference', auth: 'virtualKey', summary: 'Spend today and this month, top models and budget headroom for the calling key.' },
  { method: 'post', path: '/v1/ingest/events', tag: 'Inference', auth: 'virtualKey', summary: 'Record usage events for calls made outside the proxy (SDK / CLI queue). Up to 500 per batch, idempotent on event_id, cost computed server-side from the versioned catalog; no prompt content accepted.', body: '{ schema_version: 1, source?: "sdk"|"cli", events: [{ event_id, occurred_at, provider, model, input_tokens, output_tokens, cached_tokens?, cache_creation_tokens?, latency_ms?, status?, error_code?, streamed?, attribution?: { user, customer, lead, session, feature, environment, project, team, repo, ticket } }] }' },

  // ── Platform ───────────────────────────────────────────────────────────────
  { method: 'get', path: '/health', tag: 'Platform', auth: 'none', summary: 'Liveness + database status.' },
  { method: 'get', path: '/metrics', tag: 'Platform', auth: 'none', summary: 'Prometheus metrics (METRICS_TOKEN bearer, or private network in production).' },
  { method: 'get', path: '/v1/openapi.json', tag: 'Platform', auth: 'none', summary: 'This document.' },
  { method: 'post', path: '/v1/webhooks/connectors/{id}', tag: 'Connectors', auth: 'signature', summary: 'Inbound connector webhook; authenticated by HMAC signature (or GitLab token).' },

  // ── Management ─────────────────────────────────────────────────────────────
  { method: 'get', path: '/v1/admin/repositories', tag: 'Developer intelligence', auth: ADMIN, permission: 'spend:read', summary: 'Repositories synced from the CLI, with graph stats and counts.' },
  { method: 'get', path: '/v1/admin/repositories/{id}/graph', tag: 'Developer intelligence', auth: ADMIN, permission: 'spend:read', summary: 'Module-level graph summary for a repository. Contains no source code.' },
  { method: 'get', path: '/v1/admin/repositories/{id}/memories', tag: 'Developer intelligence', auth: ADMIN, permission: 'spend:read', summary: 'Current project memory for a repository, with the source of each entry.', query: ['category'] },
  { method: 'get', path: '/v1/admin/agent-sessions', tag: 'Developer intelligence', auth: ADMIN, permission: 'spend:read', summary: 'Coding agent sessions. Null tokens or cost mean unknown, not zero. Costs are estimates and do not count toward budgets.', query: ['agent', 'repository', 'limit'] },
  { method: 'get', path: '/v1/admin/whoami', tag: 'Platform', auth: ADMIN, permission: 'spend:read', summary: 'The authenticated principal (actor, role) and the organization it operates on.' },
  { method: 'get', path: '/v1/admin/usage/summary', tag: 'Analytics', auth: ADMIN, permission: 'spend:read', summary: 'Requests, tokens, cached tokens, cost, errors and latency percentiles over a period, optionally grouped (provider, model, user, customer, endpoint, project, feature, environment, lead, session, day).', query: ['group_by', 'since', 'until', 'provider', 'model', 'project', 'user', 'limit'] },
  { method: 'get', path: '/v1/admin/budgets', tag: 'Budgets', auth: ADMIN, permission: 'spend:read', summary: 'List budgets.' },
  { method: 'post', path: '/v1/admin/budgets', tag: 'Budgets', auth: ADMIN, permission: 'budget:write', summary: 'Create a budget for an organization, team, project or virtual key.', body: '{ scope_type, scope_id, cap_usd, period?, warn_threshold_pct?, critical_threshold_pct?, enforcement_mode? }' },
  { method: 'patch', path: '/v1/admin/budgets/{id}', tag: 'Budgets', auth: ADMIN, permission: 'budget:write', summary: 'Update a budget.' },
  { method: 'delete', path: '/v1/admin/budgets/{id}', tag: 'Budgets', auth: ADMIN, permission: 'budget:write', summary: 'Delete a budget.' },

  { method: 'get', path: '/v1/admin/policies', tag: 'Governance', auth: ADMIN, permission: 'spend:read', summary: 'List governance policies.' },
  { method: 'post', path: '/v1/admin/policies', tag: 'Governance', auth: ADMIN, permission: 'policies:write', summary: 'Create a policy (effects: allow, deny, block, require_approval, force_model).', body: '{ name, conditions, actions: { effect, model?, message? } }' },
  { method: 'post', path: '/v1/admin/policies/test', tag: 'Governance', auth: ADMIN, permission: 'spend:read', summary: 'Dry-run the enabled policies against a hypothetical request. Writes no decision rows and creates no approval requests; the call itself is audit-logged.', body: '{ model, prompt?, cost_center?, attribution?: { team, project, feature, customer, ... } }' },
  { method: 'patch', path: '/v1/admin/policies/{id}', tag: 'Governance', auth: ADMIN, permission: 'policies:write', summary: 'Update a policy.' },
  { method: 'delete', path: '/v1/admin/policies/{id}', tag: 'Governance', auth: ADMIN, permission: 'policies:write', summary: 'Delete a policy.' },

  { method: 'get', path: '/v1/admin/routing-rules', tag: 'Routing', auth: ADMIN, permission: 'spend:read', summary: 'List routing rules.' },
  { method: 'post', path: '/v1/admin/routing-rules', tag: 'Routing', auth: ADMIN, permission: 'routing:write', summary: 'Create a routing rule (strategy: cheapest, fastest, policy, fallback).', body: '{ name, strategy, targets: [{provider, model}], match?, priority? }' },
  { method: 'patch', path: '/v1/admin/routing-rules/{id}', tag: 'Routing', auth: ADMIN, permission: 'routing:write', summary: 'Update a routing rule.' },
  { method: 'delete', path: '/v1/admin/routing-rules/{id}', tag: 'Routing', auth: ADMIN, permission: 'routing:write', summary: 'Delete a routing rule.' },
  { method: 'post', path: '/v1/admin/routing-rules/simulate', tag: 'Routing', auth: ADMIN, permission: 'spend:read', summary: 'Dry-run the rule engine against a hypothetical request; nothing is sent to a provider.', body: '{ model, prompt?, max_tokens?, cost_center?, team_id?, project_id? }' },
  { method: 'get', path: '/v1/admin/models', tag: 'Routing', auth: ADMIN, permission: 'spend:read', summary: 'Price catalog joined with observed (for your organization) cost, latency and error rate over the last 30 days.' },

  { method: 'get', path: '/v1/admin/keys', tag: 'Keys', auth: ADMIN, permission: 'spend:read', summary: 'List virtual API keys (prefix only; the secret is never retrievable).' },
  { method: 'delete', path: '/v1/admin/keys/{id}', tag: 'Keys', auth: ADMIN, permission: 'keys:write', summary: 'Revoke a virtual API key. Its history is kept.' },
  { method: 'get', path: '/v1/admin/alerts', tag: 'Alerts', auth: ADMIN, permission: 'spend:read', summary: 'Recent budget alerts.', query: ['limit'] },
  { method: 'get', path: '/v1/admin/audit', tag: 'Audit', auth: ADMIN, permission: 'audit:read', summary: 'Append-only audit trail: admin actions and automated policy/budget/routing decisions.', query: ['kind', 'limit'] },
  { method: 'get', path: '/v1/admin/approvals', tag: 'Governance', auth: ADMIN, permission: 'spend:read', summary: 'Approval requests.', query: ['status'] },
  { method: 'post', path: '/v1/admin/approvals/{id}/approve', tag: 'Governance', auth: ADMIN, permission: 'approvals:decide', summary: 'Approve a pending request.' },
  { method: 'post', path: '/v1/admin/approvals/{id}/deny', tag: 'Governance', auth: ADMIN, permission: 'approvals:decide', summary: 'Deny a pending request.' },

  { method: 'get', path: '/v1/admin/workspaces', tag: 'Organization', auth: ADMIN, permission: 'spend:read', summary: 'List workspaces.' },
  { method: 'post', path: '/v1/admin/workspaces', tag: 'Organization', auth: ADMIN, permission: 'keys:write', summary: 'Create a workspace (cost center).', body: '{ name, cost_center, budget_cap_usd? }' },
  { method: 'get', path: '/v1/admin/teams', tag: 'Organization', auth: ADMIN, permission: 'spend:read', summary: 'List teams.' },
  { method: 'post', path: '/v1/admin/teams', tag: 'Organization', auth: ADMIN, permission: 'keys:write', summary: 'Create a team.', body: '{ name, slug, cost_center? }' },
  { method: 'get', path: '/v1/admin/projects', tag: 'Organization', auth: ADMIN, permission: 'spend:read', summary: 'List projects.' },
  { method: 'post', path: '/v1/admin/projects', tag: 'Organization', auth: ADMIN, permission: 'keys:write', summary: 'Create a project.', body: '{ name, slug, team_id?, environment? }' },

  { method: 'get', path: '/v1/admin/provider-keys', tag: 'Keys', auth: ADMIN, permission: 'keys:write', summary: 'List BYOK provider keys (secrets are never returned).' },
  { method: 'post', path: '/v1/admin/provider-keys', tag: 'Keys', auth: ADMIN, permission: 'keys:write', summary: 'Add a BYOK provider key (encrypted at rest).', body: '{ provider, api_key, label?, priority?, workspace_id? }' },
  { method: 'patch', path: '/v1/admin/provider-keys/{id}', tag: 'Keys', auth: ADMIN, permission: 'keys:write', summary: 'Change priority/status/label.' },
  { method: 'delete', path: '/v1/admin/provider-keys/{id}', tag: 'Keys', auth: ADMIN, permission: 'keys:write', summary: 'Remove a provider key.' },
  { method: 'post', path: '/v1/admin/keys', tag: 'Keys', auth: ADMIN, permission: 'keys:write', summary: 'Create a virtual key. The token is returned once.', body: '{ name, budgetCapUsd?, provider?, workspace_id?, budgetPeriod?, enforcementMode? }' },

  { method: 'get', path: '/v1/admin/connectors/types', tag: 'Connectors', auth: ADMIN, permission: 'spend:read', summary: 'Available connector types and their config fields.' },
  { method: 'get', path: '/v1/admin/connectors', tag: 'Connectors', auth: ADMIN, permission: 'spend:read', summary: 'List connectors.' },
  { method: 'post', path: '/v1/admin/connectors', tag: 'Connectors', auth: ADMIN, permission: 'connectors:write', summary: 'Create a connector; credentials are verified first.', body: '{ type, name, config, verify? }' },
  { method: 'post', path: '/v1/admin/connectors/{id}/test', tag: 'Connectors', auth: ADMIN, permission: 'connectors:write', summary: 'Re-verify stored credentials.' },
  { method: 'post', path: '/v1/admin/connectors/{id}/sync', tag: 'Connectors', auth: ADMIN, permission: 'connectors:write', summary: 'Run a sync now.' },
  { method: 'delete', path: '/v1/admin/connectors/{id}', tag: 'Connectors', auth: ADMIN, permission: 'connectors:write', summary: 'Delete a connector and its entities.' },
  { method: 'get', path: '/v1/admin/attribution', tag: 'Connectors', auth: ADMIN, permission: 'spend:read', summary: 'Cost per attribution dimension (repo, ticket, sprint, feature, customer, employee).', query: ['dimension'] },

  { method: 'get', path: '/v1/admin/requests', tag: 'Usage', auth: ADMIN, permission: 'spend:read', summary: 'Request history for the organization (cursor-paginated).', query: ['limit', 'before', 'status', 'actor', 'since'] },
  { method: 'get', path: '/v1/admin/reports/export', tag: 'Usage', auth: ADMIN, permission: 'reports:export', summary: 'Monthly spend per cost center / provider / model as CSV.', query: ['month'] },
];

const SECURITY: Record<RouteDoc['auth'], object[]> = {
  none: [],
  virtualKey: [{ virtualKey: [] }],
  admin: [{ adminSecret: [] }, { bearerJwt: [] }],
  signature: [],
};

export function buildOpenApi(serverUrl = '/') {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const params: object[] = [
      ...[...r.path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      ...(r.query ?? []).map(q => ({ name: q, in: 'query', required: false, schema: { type: 'string' } })),
    ];
    (paths[r.path] ??= {})[r.method] = {
      tags: [r.tag],
      summary: r.summary,
      ...(r.permission ? { description: `Requires permission \`${r.permission}\` (roles: see RBAC matrix).` } : {}),
      security: SECURITY[r.auth],
      ...(params.length ? { parameters: params } : {}),
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: r.body } } } } } : {}),
      responses: {
        '200': { description: 'Success' },
        ...(r.auth !== 'none' ? { '401': { description: 'Missing or invalid credentials' } } : {}),
        ...(r.permission ? { '403': { description: 'Role lacks the required permission' } } : {}),
        '429': { description: 'Rate limit or budget exceeded' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tokenistt Gateway API',
      version: '1.0.0',
      description: 'Open-source AI cost visibility and governance gateway. OpenAI-compatible inference plus a management API.',
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        virtualKey: { type: 'http', scheme: 'bearer', description: 'Tokenistt virtual key (tktt_live_…)' },
        adminSecret: { type: 'apiKey', in: 'header', name: 'X-Admin-Secret', description: 'Operator access; pass organization_id' },
        bearerJwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Dashboard session token; role-based, locked to its organization' },
      },
    },
    paths,
  };
}
