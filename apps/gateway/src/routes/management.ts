/**
 * routes/management.ts — management API mounted at /v1/admin.
 *
 * Auth: operator secret or dashboard JWT (see middleware/adminAuth.ts); every route is
 * permission-gated and scoped to one organization. Every mutation lands in `audit_log`.
 * Ids in URLs are public uuids; secrets (provider keys) are never returned.
 */
import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool.js';
import { adminAuth, requirePermission, orgScope, type Permission } from '../middleware/adminAuth.js';
import { logAdminAction } from '../services/auditLogger.js';
import { generateVirtualKey } from '../services/keyManager.js';
import { addProviderKey } from '../services/byok.js';
import { decideApproval, listApprovals, type ApprovalStatus } from '../services/approvals.js';
import { clearRoutingCache, ruleMatches, rankTargets, type RoutingRule } from '../services/routingEngine.js';
import { resolvePricing, calculateCost, getAvailableModels } from '../services/pricing.js';
import { estimateRequestTokens } from '../providers/base.js';
import { createConnector, listConnectors, deleteConnector, runSync, testConnector } from '../services/connectorService.js';
import { listConnectorTypes, ConnectorError } from '../connectors/registry.js';

export const managementRouter = Router();
managementRouter.use(adminAuth);

type Handler = (req: Request, org: string) => Promise<unknown> | unknown;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Wrap a handler: permission gate, org scoping, DB availability, uniform errors. */
function endpoint(permission: Permission, handler: Handler) {
  return [
    requirePermission(permission),
    async (req: Request, res: Response) => {
      if (!process.env.DATABASE_URL) {
        return void res.status(503).json({ error: { message: 'Database not configured' } });
      }
      const scope = orgScope(req);
      if (!scope.ok) return void res.status(400).json({ error: { message: scope.message } });
      try {
        const out = await handler(req, scope.organizationId);
        res.status(req.method === 'POST' && out && (out as any).__created ? 201 : 200).json(stripFlag(out));
      } catch (err: any) {
        if (err instanceof HttpError) return void res.status(err.status).json({ error: { message: err.message } });
        if (err instanceof ConnectorError) return void res.status(err.status).json({ error: { message: err.message } });
        if (err?.code === '23505') return void res.status(409).json({ error: { message: 'Already exists.' } });
        if (err?.code === '22P02' || err?.code === '23514' || err?.code === '23503') {
          return void res.status(400).json({ error: { message: `Invalid input: ${err.detail || err.message}` } });
        }
        console.error('[Management]', req.method, req.path, err.message);
        res.status(500).json({ error: { message: 'Internal error' } });
      }
    },
  ] as const;
}

function created<T extends object>(v: T): T & { __created: true } {
  return { ...v, __created: true };
}
function stripFlag(v: any) {
  if (v && typeof v === 'object' && '__created' in v) {
    const { __created, ...rest } = v;
    return rest;
  }
  return v;
}

const pool = () => getPool();
const pid = (req: Request): string => String(req.params.id);
const audit = (req: Request, org: string, action: string, entityType: string, entityId: string | undefined, before: unknown, after: unknown) =>
  logAdminAction({
    organizationId: org, actor: req.principal!.actor, action, entityType, entityId, before, after, ip: req.ip,
  });

const need = (cond: unknown, message: string) => {
  if (!cond) throw new HttpError(400, message);
};
const notFound = (row: unknown, what: string) => {
  if (!row) throw new HttpError(404, `${what} not found`);
};

// ── Budgets ──────────────────────────────────────────────────────────────────

const BUDGET_COLS = `public_id::text AS id, scope_type, scope_id::text, name, cap_usd::text, period,
  warn_threshold_pct::text, critical_threshold_pct::text, enforcement_mode, is_active, created_at`;

managementRouter.get('/budgets', ...endpoint('spend:read', async (_req, org) =>
  (await pool().query(`SELECT ${BUDGET_COLS} FROM budgets WHERE organization_id = $1 ORDER BY created_at DESC`, [org])).rows));

managementRouter.post('/budgets', ...endpoint('budget:write', async (req, org) => {
  const b = req.body ?? {};
  need(['organization', 'team', 'project', 'virtual_key'].includes(b.scope_type), 'scope_type must be organization|team|project|virtual_key');
  need(b.scope_id !== undefined && /^\d+$/.test(String(b.scope_id)), 'scope_id (numeric) is required');
  need(Number(b.cap_usd) >= 0.01, 'cap_usd must be at least 0.01 (budgets are stored to the cent)');
  const { rows } = await pool().query(
    `INSERT INTO budgets (organization_id, scope_type, scope_id, name, cap_usd, period, warn_threshold_pct, critical_threshold_pct, enforcement_mode)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'monthly'),COALESCE($7,80),COALESCE($8,90),COALESCE($9,'hard_cap'))
     RETURNING ${BUDGET_COLS}`,
    [org, b.scope_type, b.scope_id, b.name ?? null, b.cap_usd, b.period ?? null, b.warn_threshold_pct ?? null,
     b.critical_threshold_pct ?? null, b.enforcement_mode ?? null]);
  audit(req, org, 'budget.create', 'budget', rows[0].id, undefined, rows[0]);
  return created(rows[0]);
}));

managementRouter.patch('/budgets/:id', ...endpoint('budget:write', async (req, org) => {
  const b = req.body ?? {};
  if (b.cap_usd !== undefined) need(Number(b.cap_usd) >= 0.01, 'cap_usd must be at least 0.01 (budgets are stored to the cent)');
  const before = (await pool().query(`SELECT ${BUDGET_COLS} FROM budgets WHERE public_id::text = $1 AND organization_id = $2`, [pid(req), org])).rows[0];
  notFound(before, 'Budget');
  const { rows } = await pool().query(
    `UPDATE budgets SET
        name = COALESCE($3, name), cap_usd = COALESCE($4, cap_usd), period = COALESCE($5, period),
        warn_threshold_pct = COALESCE($6, warn_threshold_pct), critical_threshold_pct = COALESCE($7, critical_threshold_pct),
        enforcement_mode = COALESCE($8, enforcement_mode), is_active = COALESCE($9, is_active)
      WHERE public_id::text = $1 AND organization_id = $2 RETURNING ${BUDGET_COLS}`,
    [pid(req), org, b.name ?? null, b.cap_usd ?? null, b.period ?? null, b.warn_threshold_pct ?? null,
     b.critical_threshold_pct ?? null, b.enforcement_mode ?? null, b.is_active ?? null]);
  audit(req, org, 'budget.update', 'budget', pid(req), before, rows[0]);
  return rows[0];
}));

managementRouter.delete('/budgets/:id', ...endpoint('budget:write', async (req, org) => {
  const { rows } = await pool().query(`DELETE FROM budgets WHERE public_id::text = $1 AND organization_id = $2 RETURNING ${BUDGET_COLS}`, [pid(req), org]);
  notFound(rows[0], 'Budget');
  audit(req, org, 'budget.delete', 'budget', pid(req), rows[0], undefined);
  return { deleted: true };
}));

// ── Policies ─────────────────────────────────────────────────────────────────

const POLICY_COLS = `public_id::text AS id, name, description, is_enabled, conditions, actions, created_at, updated_at`;
const EFFECTS = ['allow', 'deny', 'block', 'require_approval', 'force_model'];

managementRouter.get('/policies', ...endpoint('spend:read', async (_req, org) =>
  (await pool().query(`SELECT ${POLICY_COLS} FROM policies WHERE organization_id = $1 ORDER BY id`, [org])).rows));

managementRouter.post('/policies', ...endpoint('policies:write', async (req, org) => {
  const b = req.body ?? {};
  need(b.name, 'name is required');
  need(b.actions && EFFECTS.includes(b.actions.effect), `actions.effect must be one of ${EFFECTS.join('|')}`);
  need(b.actions.effect !== 'force_model' || b.actions.model, 'force_model requires actions.model');
  const { rows } = await pool().query(
    `INSERT INTO policies (organization_id, name, description, is_enabled, conditions, actions)
     VALUES ($1,$2,$3,COALESCE($4,true),$5,$6) RETURNING ${POLICY_COLS}`,
    [org, b.name, b.description ?? null, b.is_enabled ?? null, JSON.stringify(b.conditions ?? {}), JSON.stringify(b.actions)]);
  audit(req, org, 'policy.create', 'policy', rows[0].id, undefined, rows[0]);
  return created(rows[0]);
}));

managementRouter.patch('/policies/:id', ...endpoint('policies:write', async (req, org) => {
  const b = req.body ?? {};
  if (b.actions) need(EFFECTS.includes(b.actions.effect), `actions.effect must be one of ${EFFECTS.join('|')}`);
  const before = (await pool().query(`SELECT ${POLICY_COLS} FROM policies WHERE public_id::text = $1 AND organization_id = $2`, [pid(req), org])).rows[0];
  notFound(before, 'Policy');
  const { rows } = await pool().query(
    `UPDATE policies SET name = COALESCE($3,name), description = COALESCE($4,description), is_enabled = COALESCE($5,is_enabled),
        conditions = COALESCE($6,conditions), actions = COALESCE($7,actions), updated_at = now()
      WHERE public_id::text = $1 AND organization_id = $2 RETURNING ${POLICY_COLS}`,
    [pid(req), org, b.name ?? null, b.description ?? null, b.is_enabled ?? null,
     b.conditions ? JSON.stringify(b.conditions) : null, b.actions ? JSON.stringify(b.actions) : null]);
  audit(req, org, 'policy.update', 'policy', pid(req), before, rows[0]);
  return rows[0];
}));

managementRouter.delete('/policies/:id', ...endpoint('policies:write', async (req, org) => {
  const { rows } = await pool().query(`DELETE FROM policies WHERE public_id::text = $1 AND organization_id = $2 RETURNING ${POLICY_COLS}`, [pid(req), org]);
  notFound(rows[0], 'Policy');
  audit(req, org, 'policy.delete', 'policy', pid(req), rows[0], undefined);
  return { deleted: true };
}));

// ── Routing rules ────────────────────────────────────────────────────────────

const RULE_COLS = `public_id::text AS id, name, priority, strategy, match, targets, is_enabled, created_at, updated_at`;
const STRATEGIES = ['cheapest', 'fastest', 'policy', 'fallback'];
const validTargets = (t: unknown) =>
  Array.isArray(t) && t.length > 0 && t.every((x: any) => x && typeof x.provider === 'string' && typeof x.model === 'string');

managementRouter.get('/routing-rules', ...endpoint('spend:read', async (_req, org) => {
  const { rows } = await pool().query(`SELECT ${RULE_COLS} FROM routing_rules WHERE organization_id = $1 ORDER BY priority, id`, [org]);
  const fired = await pool().query(
    `SELECT subject_id, count(*)::int AS n, max(created_at) AS last_at FROM policy_audit_log
      WHERE organization_id = $1 AND kind = 'routing' AND created_at > now() - interval '24 hours' GROUP BY subject_id`, [org]);
  const byRule = new Map(fired.rows.map(r => [String(r.subject_id), r]));
  return rows.map(r => ({ ...r, fired_24h: byRule.get(r.id)?.n ?? 0, last_fired_at: byRule.get(r.id)?.last_at ?? null }));
}));

// Dry-run the real rule engine against a hypothetical request. Nothing is sent or logged.
managementRouter.post('/routing-rules/simulate', ...endpoint('spend:read', async (req, org) => {
  const b = req.body ?? {};
  need(typeof b.model === 'string' && b.model, 'model is required');
  const messages = [{ role: 'user', content: String(b.prompt ?? '') }];
  const inTokens = estimateRequestTokens(messages as any);
  const outTokens = Number(b.max_tokens) > 0 ? Number(b.max_tokens) : 500;
  const { rows } = await pool().query(
    `SELECT public_id::text AS id, name, priority, strategy, match, targets FROM routing_rules
      WHERE organization_id = $1 AND is_enabled = true ORDER BY priority, id`, [org]);
  const auth: any = { costCenter: b.cost_center ?? '', attribution: { teamId: b.team_id, projectId: b.project_id } };
  const rule = (rows as RoutingRule[]).find(r => Array.isArray(r.targets) && r.targets.length > 0 && ruleMatches(r, auth, b.model));
  const estimate = (t: { provider: string; model: string }) => {
    const c = calculateCost(t.provider, t.model, inTokens, outTokens);
    return c > 0 ? c : null;
  };
  if (!rule) return { matched: false, requested_model: b.model, input_tokens: inTokens, output_tokens: outTokens };
  const lat = (await pool().query(
    `SELECT provider, model, AVG(duration_ms)::float AS avg_ms FROM transactions
      WHERE organization_id = $1 AND created_at > now() - interval '24 hours' AND status = 'success' AND duration_ms IS NOT NULL
      GROUP BY provider, model`, [org])).rows;
  const latMap = new Map(lat.map(r => [`${r.provider}:${r.model}`, r.avg_ms as number]));
  const ranked = rankTargets(rule.strategy, rule.targets, [], { estimateCost: estimate, latencyMs: t => latMap.get(`${t.provider}:${t.model}`) ?? null });
  return {
    matched: true, rule: { id: rule.id, name: rule.name, strategy: rule.strategy },
    requested_model: b.model, input_tokens: inTokens, output_tokens: outTokens,
    candidates: ranked.map(t => ({ ...t, est_cost_usd: estimate(t), avg_latency_ms: latMap.get(`${t.provider}:${t.model}`) ?? null })),
  };
}));

// Price catalog joined with what this org actually observed in the last 30 days.
managementRouter.get('/models', ...endpoint('spend:read', async (_req, org) => {
  const obs = (await pool().query(
    `SELECT provider, model, count(*)::int AS requests,
            COALESCE(AVG(cost_usd) FILTER (WHERE status = 'success'), 0)::float AS avg_cost_usd,
            AVG(duration_ms) FILTER (WHERE status = 'success')::float AS avg_latency_ms,
            (count(*) FILTER (WHERE status <> 'success'))::float / NULLIF(count(*), 0) AS error_rate
       FROM transactions WHERE organization_id = $1 AND created_at > now() - interval '30 days'
      GROUP BY provider, model`, [org])).rows;
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of obs) {
    seen.add(`${r.provider}:${r.model}`);
    const price = resolvePricing(r.provider, r.model);
    out.push({ ...r, input_per_1m: price?.input ?? null, output_per_1m: price?.output ?? null });
  }
  for (const [provider, models] of Object.entries(getAvailableModels())) {
    for (const model of models) {
      if (seen.has(`${provider}:${model}`)) continue;
      const price = resolvePricing(provider, model);
      if (price) out.push({ provider, model, requests: 0, avg_cost_usd: null, avg_latency_ms: null, error_rate: null, input_per_1m: price.input, output_per_1m: price.output });
    }
  }
  return out;
}));

managementRouter.post('/routing-rules', ...endpoint('routing:write', async (req, org) => {
  const b = req.body ?? {};
  need(b.name, 'name is required');
  need(STRATEGIES.includes(b.strategy), `strategy must be one of ${STRATEGIES.join('|')}`);
  need(validTargets(b.targets), 'targets must be a non-empty array of {provider, model}');
  const { rows } = await pool().query(
    `INSERT INTO routing_rules (organization_id, name, priority, strategy, match, targets, is_enabled)
     VALUES ($1,$2,COALESCE($3,100),$4,$5,$6,COALESCE($7,true)) RETURNING ${RULE_COLS}`,
    [org, b.name, b.priority ?? null, b.strategy, JSON.stringify(b.match ?? {}), JSON.stringify(b.targets), b.is_enabled ?? null]);
  clearRoutingCache();
  audit(req, org, 'routing_rule.create', 'routing_rule', rows[0].id, undefined, rows[0]);
  return created(rows[0]);
}));

managementRouter.patch('/routing-rules/:id', ...endpoint('routing:write', async (req, org) => {
  const b = req.body ?? {};
  if (b.strategy) need(STRATEGIES.includes(b.strategy), `strategy must be one of ${STRATEGIES.join('|')}`);
  if (b.targets) need(validTargets(b.targets), 'targets must be a non-empty array of {provider, model}');
  const before = (await pool().query(`SELECT ${RULE_COLS} FROM routing_rules WHERE public_id::text = $1 AND organization_id = $2`, [pid(req), org])).rows[0];
  notFound(before, 'Routing rule');
  const { rows } = await pool().query(
    `UPDATE routing_rules SET name = COALESCE($3,name), priority = COALESCE($4,priority), strategy = COALESCE($5,strategy),
        match = COALESCE($6,match), targets = COALESCE($7,targets), is_enabled = COALESCE($8,is_enabled), updated_at = now()
      WHERE public_id::text = $1 AND organization_id = $2 RETURNING ${RULE_COLS}`,
    [pid(req), org, b.name ?? null, b.priority ?? null, b.strategy ?? null,
     b.match ? JSON.stringify(b.match) : null, b.targets ? JSON.stringify(b.targets) : null, b.is_enabled ?? null]);
  clearRoutingCache();
  audit(req, org, 'routing_rule.update', 'routing_rule', pid(req), before, rows[0]);
  return rows[0];
}));

managementRouter.delete('/routing-rules/:id', ...endpoint('routing:write', async (req, org) => {
  const { rows } = await pool().query(`DELETE FROM routing_rules WHERE public_id::text = $1 AND organization_id = $2 RETURNING ${RULE_COLS}`, [pid(req), org]);
  notFound(rows[0], 'Routing rule');
  clearRoutingCache();
  audit(req, org, 'routing_rule.delete', 'routing_rule', pid(req), rows[0], undefined);
  return { deleted: true };
}));

// ── Alerts, audit trail, approvals ───────────────────────────────────────────

const limitOf = (req: Request, max = 200) => Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), max);

managementRouter.get('/alerts', ...endpoint('spend:read', async (req, org) =>
  (await pool().query(
    `SELECT public_id::text AS id, budget_id::text, severity, title, message, channels, metadata, created_at
       FROM budget_alerts WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2`, [org, limitOf(req)])).rows));

managementRouter.get('/audit', ...endpoint('audit:read', async (req, org) => {
  const limit = limitOf(req);
  const kind = String(req.query.kind ?? 'all');
  const out: Record<string, unknown[]> = {};
  if (kind === 'all' || kind === 'actions') {
    out.actions = (await pool().query(
      `SELECT public_id::text AS id, actor, action, entity_type, entity_id, before, after, ip, created_at
         FROM audit_log WHERE organization_id = $1 ORDER BY id DESC LIMIT $2`, [org, limit])).rows;
  }
  if (kind === 'all' || kind === 'decisions') {
    out.decisions = (await pool().query(
      `SELECT id::text, kind, subject_id, request_id, decision, reason, metadata, created_at
         FROM policy_audit_log WHERE organization_id = $1 ORDER BY id DESC LIMIT $2`, [org, limit])).rows;
  }
  return out;
}));

managementRouter.get('/approvals', ...endpoint('spend:read', async (req, org) =>
  listApprovals(org, req.query.status as ApprovalStatus | undefined)));

for (const [path, decision] of [['approve', 'approved'], ['deny', 'denied']] as const) {
  managementRouter.post(`/approvals/:id/${path}`, ...endpoint('approvals:decide', async (req, org) => {
    const owned = await pool().query('SELECT 1 FROM approval_requests WHERE public_id::text = $1 AND organization_id = $2', [pid(req), org]);
    notFound(owned.rows[0], 'Approval');
    const row = await decideApproval(pid(req), decision, req.principal!.actor);
    if (!row) throw new HttpError(409, 'Approval is no longer pending (already decided or expired).');
    audit(req, org, `approval.${path}`, 'approval', pid(req), { status: 'pending' }, { status: row.status });
    return row;
  }));
}

// ── Workspaces, teams, projects ──────────────────────────────────────────────

managementRouter.get('/workspaces', ...endpoint('spend:read', async (_req, org) =>
  (await pool().query(`SELECT id::text, public_id::text AS public_id, name, cost_center, budget_cap_usd::text, created_at FROM workspaces WHERE organization_id = $1 ORDER BY id`, [org])).rows));

managementRouter.post('/workspaces', ...endpoint('keys:write', async (req, org) => {
  const b = req.body ?? {};
  need(b.name && b.cost_center, 'name and cost_center are required');
  const { rows } = await pool().query(
    `INSERT INTO workspaces (organization_id, name, cost_center, budget_cap_usd) VALUES ($1,$2,$3,$4)
     RETURNING id::text, public_id::text AS public_id, name, cost_center, budget_cap_usd::text, created_at`,
    [org, b.name, b.cost_center, b.budget_cap_usd ?? null]);
  audit(req, org, 'workspace.create', 'workspace', rows[0].public_id, undefined, rows[0]);
  return created(rows[0]);
}));

managementRouter.get('/teams', ...endpoint('spend:read', async (_req, org) =>
  (await pool().query(`SELECT id::text, public_id::text AS public_id, name, slug, cost_center, created_at FROM teams WHERE organization_id = $1 ORDER BY id`, [org])).rows));

managementRouter.post('/teams', ...endpoint('keys:write', async (req, org) => {
  const b = req.body ?? {};
  need(b.name && /^[a-z0-9][a-z0-9-]*$/.test(b.slug ?? ''), 'name and a lowercase slug (a-z, 0-9, -) are required');
  const { rows } = await pool().query(
    `INSERT INTO teams (organization_id, name, slug, cost_center) VALUES ($1,$2,$3,$4)
     RETURNING id::text, public_id::text AS public_id, name, slug, cost_center, created_at`,
    [org, b.name, b.slug, b.cost_center ?? null]);
  audit(req, org, 'team.create', 'team', rows[0].public_id, undefined, rows[0]);
  return created(rows[0]);
}));

managementRouter.get('/projects', ...endpoint('spend:read', async (_req, org) =>
  (await pool().query(`SELECT id::text, public_id::text AS public_id, team_id::text, name, slug, environment, created_at FROM projects WHERE organization_id = $1 ORDER BY id`, [org])).rows));

managementRouter.post('/projects', ...endpoint('keys:write', async (req, org) => {
  const b = req.body ?? {};
  need(b.name && /^[a-z0-9][a-z0-9-]*$/.test(b.slug ?? ''), 'name and a lowercase slug (a-z, 0-9, -) are required');
  const { rows } = await pool().query(
    `INSERT INTO projects (organization_id, team_id, name, slug, environment)
     VALUES ($1,(SELECT id FROM teams WHERE organization_id = $1 AND id::text = $2),$3,$4,COALESCE($5,'production'))
     RETURNING id::text, public_id::text AS public_id, team_id::text, name, slug, environment, created_at`,
    [org, b.team_id ? String(b.team_id) : null, b.name, b.slug, b.environment ?? null]);
  audit(req, org, 'project.create', 'project', rows[0].public_id, undefined, rows[0]);
  return created(rows[0]);
}));

// ── Provider keys (BYOK) — secrets are write-only ────────────────────────────

const PK_COLS = `public_id::text AS id, provider, label, priority, status, last_error, last_used_at, workspace_id::text, created_at`;

managementRouter.get('/provider-keys', ...endpoint('keys:write', async (_req, org) =>
  (await pool().query(`SELECT ${PK_COLS} FROM provider_keys WHERE organization_id = $1 ORDER BY provider, priority`, [org])).rows));

managementRouter.post('/provider-keys', ...endpoint('keys:write', async (req, org) => {
  const b = req.body ?? {};
  need(typeof b.provider === 'string' && b.provider, 'provider is required');
  need(typeof b.api_key === 'string' && b.api_key.length >= 8, 'api_key is required');
  const { id } = await addProviderKey({
    organizationId: org, workspaceId: b.workspace_id ?? null, provider: b.provider.toLowerCase(),
    label: b.label, apiKey: b.api_key, priority: b.priority,
  });
  const row = (await pool().query(`SELECT ${PK_COLS} FROM provider_keys WHERE public_id::text = $1`, [id])).rows[0];
  audit(req, org, 'provider_key.create', 'provider_key', id, undefined, row);
  return created(row);
}));

managementRouter.patch('/provider-keys/:id', ...endpoint('keys:write', async (req, org) => {
  const b = req.body ?? {};
  if (b.status) need(['active', 'disabled'].includes(b.status), 'status must be active|disabled');
  const { rows } = await pool().query(
    `UPDATE provider_keys SET priority = COALESCE($3,priority), status = COALESCE($4,status), label = COALESCE($5,label)
      WHERE public_id::text = $1 AND organization_id = $2 RETURNING ${PK_COLS}`,
    [pid(req), org, b.priority ?? null, b.status ?? null, b.label ?? null]);
  notFound(rows[0], 'Provider key');
  audit(req, org, 'provider_key.update', 'provider_key', pid(req), undefined, rows[0]);
  return rows[0];
}));

managementRouter.delete('/provider-keys/:id', ...endpoint('keys:write', async (req, org) => {
  const { rows } = await pool().query(`DELETE FROM provider_keys WHERE public_id::text = $1 AND organization_id = $2 RETURNING ${PK_COLS}`, [pid(req), org]);
  notFound(rows[0], 'Provider key');
  audit(req, org, 'provider_key.delete', 'provider_key', pid(req), rows[0], undefined);
  return { deleted: true };
}));

// ── Simple key creation: POST /v1/admin/keys { name, budgetCapUsd, provider } ─

managementRouter.post('/keys', ...endpoint('keys:write', async (req, org) => {
  const b = req.body ?? {};
  need(typeof b.name === 'string' && b.name.trim(), 'name is required');
  const cap = b.budgetCapUsd ?? b.budget_cap_usd;
  need(cap === undefined || cap === null || Number(cap) > 0, 'budgetCapUsd must be > 0');
  const keyInfo = generateVirtualKey(`org_${org}`, b.name);
  const metadata = { rate_limit_per_minute: b.rateLimitPerMinute ?? 100, enforcement_mode: b.enforcementMode ?? 'hard_cap' };
  const { rows } = await pool().query(
    `INSERT INTO virtual_keys (organization_id, workspace_id, name, key_prefix, key_hash, budget_cap_usd, budget_period, allowed_providers, status, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'monthly'),$8,'active',$9)
     RETURNING public_id::text AS id, name, key_prefix, budget_cap_usd::text, budget_period, allowed_providers, status, created_at`,
    [org, b.workspace_id ?? null, b.name, keyInfo.keyPrefix, keyInfo.keyHash, cap ?? null, b.budgetPeriod ?? null,
     b.provider ? [String(b.provider).toLowerCase()] : [], JSON.stringify(metadata)]);
  audit(req, org, 'key.create', 'virtual_key', rows[0].id, undefined, rows[0]);
  // The raw token is shown exactly once and never stored.
  return created({ ...rows[0], token: keyInfo.rawToken });
}));

managementRouter.get('/keys', ...endpoint('spend:read', async (_req, org) =>
  (await pool().query(
    // last_used_at on the row is not maintained on the hot path; derive it from the ledger instead.
    `SELECT vk.public_id::text AS id, vk.name, vk.key_prefix, vk.status, vk.budget_cap_usd::text, vk.budget_period, vk.allowed_providers,
            (SELECT max(t.created_at) FROM transactions t WHERE t.virtual_key_id = vk.id) AS last_used_at, vk.created_at, vk.revoked_at
       FROM virtual_keys vk WHERE vk.organization_id = $1 ORDER BY vk.created_at DESC`, [org])).rows));

// Revoke (never hard-delete: the key's history stays attributable).
managementRouter.delete('/keys/:id', ...endpoint('keys:write', async (req, org) => {
  const { rows } = await pool().query(
    `UPDATE virtual_keys SET status = 'revoked', revoked_at = now()
      WHERE public_id::text = $1 AND organization_id = $2 AND status <> 'revoked'
      RETURNING public_id::text AS id, name, status`, [pid(req), org]);
  notFound(rows[0], 'Active key');
  audit(req, org, 'key.revoke', 'virtual_key', pid(req), undefined, rows[0]);
  return { revoked: true, ...rows[0] };
}));

// ── Connectors ───────────────────────────────────────────────────────────────

managementRouter.get('/connectors/types', requirePermission('spend:read'), (_req: Request, res: Response) => {
  res.json(listConnectorTypes());
});

managementRouter.get('/connectors', ...endpoint('spend:read', async (_req, org) => listConnectors(org)));

managementRouter.post('/connectors', ...endpoint('connectors:write', async (req, org) => {
  const b = req.body ?? {};
  need(typeof b.type === 'string' && typeof b.name === 'string' && b.name.trim(), 'type and name are required');
  need(b.config && typeof b.config === 'object', 'config object is required');
  const row = await createConnector(org, b.type, b.name.trim(), b.config, b.verify !== false);
  audit(req, org, 'connector.create', 'connector', row.id, undefined, { type: row.type, name: row.name }); // config omitted: it holds secrets
  return created(row);
}));

managementRouter.post('/connectors/:id/test', ...endpoint('connectors:write', async (req, org) => {
  await testConnector(pid(req), org);
  return { ok: true };
}));

managementRouter.post('/connectors/:id/sync', ...endpoint('connectors:write', async (req, org) => {
  const out = await runSync(pid(req), org);
  audit(req, org, 'connector.sync', 'connector', pid(req), undefined, out);
  return out;
}));

managementRouter.delete('/connectors/:id', ...endpoint('connectors:write', async (req, org) => {
  const ok = await deleteConnector(org, pid(req));
  notFound(ok, 'Connector');
  audit(req, org, 'connector.delete', 'connector', pid(req), undefined, undefined);
  return { deleted: true };
}));

managementRouter.get('/attribution', ...endpoint('spend:read', async (req, org) => {
  const dim = req.query.dimension ? String(req.query.dimension) : null;
  return (await pool().query(
    `SELECT dimension, value, label, cost_usd::text, total_tokens::text, requests::text, first_seen, last_seen
       FROM v_cost_by_dimension WHERE organization_id = $1 AND ($2::text IS NULL OR dimension = $2)
      ORDER BY cost_usd DESC LIMIT 200`, [org, dim])).rows;
}));

// ── Request history + cost report (CSV) ──────────────────────────────────────

managementRouter.get('/requests', ...endpoint('spend:read', async (req, org) => {
  const limit = limitOf(req, 500);
  const cursor = req.query.before ? String(req.query.before) : null;
  const { rows } = await pool().query(
    `SELECT id::text, public_id::text AS public_id, request_id, provider, model, actor, cost_center, project_tag,
            cost_usd::text, prompt_tokens, completion_tokens, status, error_code, duration_ms, created_at
       FROM transactions
      WHERE organization_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
        AND ($4::text IS NULL OR status = $4)
        AND ($5::text IS NULL OR actor = $5)
        AND ($6::timestamptz IS NULL OR created_at >= $6::timestamptz)
      ORDER BY id DESC LIMIT $3`, [org, cursor, limit, req.query.status ? String(req.query.status) : null,
        req.query.actor ? String(req.query.actor) : null, req.query.since ? String(req.query.since) : null]);
  return { data: rows, next_before: rows.length === limit ? rows[rows.length - 1].id : null };
}));

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // neutralise spreadsheet formula injection, then quote
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

managementRouter.get('/reports/export', requirePermission('reports:export'), async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) return void res.status(503).json({ error: { message: 'Database not configured' } });
  const scope = orgScope(req);
  if (!scope.ok) return void res.status(400).json({ error: { message: scope.message } });
  const month = String(req.query.month ?? new Date().toISOString().slice(0, 7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return void res.status(400).json({ error: { message: 'month must be YYYY-MM' } });
  }
  try {
    const { rows } = await pool().query(
      `SELECT cost_center, provider, model, COUNT(*) AS requests, SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens, ROUND(SUM(cost_usd), 6) AS cost_usd
         FROM transactions
        WHERE organization_id = $1 AND created_at >= ($2 || '-01')::date AND created_at < (($2 || '-01')::date + interval '1 month')
        GROUP BY cost_center, provider, model ORDER BY cost_center, cost_usd DESC`,
      [scope.organizationId, month]);
    const cols = ['cost_center', 'provider', 'model', 'requests', 'prompt_tokens', 'completion_tokens', 'cost_usd'];
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => csvCell((r as any)[c])).join(','))].join('\n') + '\n';
    audit(req, scope.organizationId, 'report.export', 'report', month, undefined, { rows: rows.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tokenistt-spend-${month}.csv"`);
    res.send(csv);
  } catch (err: any) {
    console.error('[Management] export failed:', err.message);
    res.status(500).json({ error: { message: 'Internal error' } });
  }
});
