/** Commands over the gateway's ledger and catalog, plus local agent usage, which is always labelled separately. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CliError, UsageError } from '../core/errors.js';
import { readStdin } from '../core/prompt.js';
import { listSessions, readPrices, refresh, summarize, type PriceTable } from '../agents/sessions.js';
import { findOptimizations, type ModelInfo, type UsageRow } from '../services/optimize.js';
import { repoInfo } from '../project/git.js';
import { openDatabase } from '../store/db.js';
import { projectDir, readProjectConfig } from '../store/project.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

const GROUPS = ['provider', 'model', 'user', 'customer', 'endpoint', 'project', 'feature', 'environment', 'lead', 'session', 'day'];
const DAYS = 86_400_000;

function period(o: { since?: string; until?: string; days?: string }): { since?: string; until?: string } {
  if (o.since || o.until) return { ...(o.since ? { since: o.since } : {}), ...(o.until ? { until: o.until } : {}) };
  const days = Number(o.days ?? 30);
  if (!Number.isFinite(days) || days <= 0) throw new UsageError(`Invalid --days "${o.days}".`);
  return { since: new Date(Date.now() - days * DAYS).toISOString() };
}

interface Summary { group_by: string; since: string; until: string; rows: Array<UsageRow & { avg_latency_ms: number | null; p95_latency_ms: number | null }> }

/** Agent sessions recorded here, if this is a set-up repository. Separate from the ledger: this is not spend. */
function localAgents(): Array<{ agent: string; sessions: number; tokens: number | null; costUsd: number | null }> {
  const repo = repoInfo(process.cwd());
  if (!repo || !readProjectConfig(repo.root)) return [];
  const db = openDatabase(repo.root);
  try {
    refresh(repo.root, db);
    const prices = readPrices(repo.root);
    const now = Date.now();
    const by = new Map<string, Array<ReturnType<typeof summarize>>>();
    for (const r of listSessions(db, { limit: 2000 })) by.set(r.agent, [...(by.get(r.agent) ?? []), summarize(db, r, now, prices)]);
    return [...by].map(([agent, list]) => ({
      agent, sessions: list.length,
      tokens: list.every((s) => s.tokens) ? list.reduce((t, s) => t + (s.tokens?.total ?? 0), 0) : null,
      costUsd: list.every((s) => s.cost.costUsd !== null) ? list.reduce((t, s) => t + (s.cost.costUsd ?? 0), 0) : null,
    }));
  } finally {
    db.close();
  }
}

function renderAgents(ctx: Context, agents: ReturnType<typeof localAgents>): void {
  if (!agents.length) return;
  ctx.out.line();
  ctx.out.line(ctx.out.bold('Coding agents in this repository'));
  ctx.out.line(ctx.out.dim('Not in the totals above unless you opted in with `tokenistt sync --ledger`. Costs are estimates; on a subscription they are not spend.'));
  ctx.out.table(agents.map((a) => ({ agent: a.agent, sessions: a.sessions, tokens: a.tokens === null ? 'unknown' : a.tokens.toLocaleString('en-US'), cost: a.costUsd === null ? 'unknown' : `~$${a.costUsd.toFixed(4)}` })), [{ key: 'agent' }, { key: 'sessions', align: 'right' }, { key: 'tokens', align: 'right' }, { key: 'cost', align: 'right' }]);
}

export function registerReports(program: Command, getCtx: GetCtx): void {
  const dates = (c: Command): Command => c.option('--days <n>', 'the last n days', '30').option('--since <date>', 'start of the period').option('--until <date>', 'end of the period');

  const report = (name: string, description: string, money: boolean): void => {
    dates(program.command(name).description(description))
      .option('--by <dimension>', `group by: ${GROUPS.join(', ')}`, money ? 'model' : 'provider')
      .option('--csv', 'write CSV to stdout')
      .action(async (o: { by: string; csv?: boolean; days?: string; since?: string; until?: string }, cmd: Command) => {
        const ctx = getCtx(cmd);
        if (!GROUPS.includes(o.by)) throw new UsageError(`Cannot group by "${o.by}".`, `Use one of: ${GROUPS.join(', ')}.`);
        const s = await ctx.makeClient().get<Summary>('management', '/v1/admin/usage/summary', { query: { group_by: o.by, ...period(o) } });
        const rows = s.rows.map((r) => ({
          [o.by]: r.key ?? '(none)', requests: r.requests, input: Number(r.input_tokens), output: Number(r.output_tokens), cached: Number(r.cached_tokens),
          cost_usd: Number(r.cost_usd), unpriced: r.zero_cost_requests, errors: r.errors,
        })) as Array<Record<string, string | number>>;
        if (o.csv) {
          process.stdout.write(ctx.out.csv(rows, [o.by, 'requests', 'input', 'output', 'cached', 'cost_usd', 'unpriced', 'errors']));
          return;
        }
        const agents = localAgents();
        ctx.out.result({ ...s, agents }, () => {
          ctx.out.line(`${ctx.out.bold(`Ledger by ${o.by}`)}  ${s.since.slice(0, 10)} to ${s.until.slice(0, 10)}`);
          ctx.out.table(rows, [
            { key: o.by }, { key: 'requests', align: 'right' }, { key: 'input', align: 'right' }, { key: 'output', align: 'right' }, { key: 'cached', align: 'right' },
            { key: 'cost_usd', header: 'cost', align: 'right', format: (v) => `$${Number(v).toFixed(4)}` }, { key: 'unpriced', align: 'right' }, { key: 'errors', align: 'right' },
          ]);
          if (rows.some((r) => Number(r.unpriced) > 0)) ctx.out.warn('Unpriced requests have no catalog price, so they count as $0.00 and the total is understated.');
          ctx.out.line(ctx.out.dim('Costs are tokens times catalog prices. See reconciliation in the dashboard to compare with invoices.'));
          renderAgents(ctx, agents);
        });
      });
  };
  report('usage', 'Requests and tokens from your gateway, plus agent sessions recorded here', false);
  report('cost', 'What it cost, by model or another dimension', true);

  const models = program.command('models').description('Models in your gateway catalog and how they have performed')
    .option('--refresh', 'save catalog prices here, so session costs can be estimated offline');
  models.action(async (o: { refresh?: boolean }, cmd: Command) => {
    const ctx = getCtx(cmd);
    const rows = await ctx.makeClient().get<Array<ModelInfo & { requests: number; avg_latency_ms: number | null; error_rate: number | null; cached_input_per_1m?: number | null; cache_write_per_1m?: number | null }>>('management', '/v1/admin/models');
    if (o.refresh) {
      const repo = repoInfo(process.cwd());
      if (!repo || !readProjectConfig(repo.root)) throw new UsageError('Saving prices needs a set-up repository.', 'Run `tokenistt init` first.');
      const table: PriceTable = {};
      for (const m of rows) {
        if (m.input_per_1m === null || m.output_per_1m === null) continue;
        table[m.model] = { input: m.input_per_1m, output: m.output_per_1m, ...(m.cached_input_per_1m != null ? { cachedInput: m.cached_input_per_1m } : {}), ...(m.cache_write_per_1m != null ? { cacheWrite: m.cache_write_per_1m } : {}) };
      }
      const dir = join(projectDir(repo.root), 'cache');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'prices.json'), `${JSON.stringify(table, null, 2)}\n`);
      ctx.out.result({ saved: Object.keys(table).length }, () => ctx.out.success(`Saved prices for ${Object.keys(table).length} models from your gateway.`));
      return;
    }
    ctx.out.result({ models: rows }, () => ctx.out.table(rows.map((m) => ({ ...m, used: m.requests })), [
      { key: 'provider' }, { key: 'model' }, { key: 'input_per_1m', header: 'input/1M', align: 'right', format: (v) => (v === null ? 'unknown' : `$${v}`) }, { key: 'output_per_1m', header: 'output/1M', align: 'right', format: (v) => (v === null ? 'unknown' : `$${v}`) }, { key: 'used', align: 'right' },
    ]));
  });

  const providers = program.command('providers').description('Provider API keys held by your gateway. Keys are write-only');
  const PK = '/v1/admin/provider-keys';
  providers.action(async (_o: unknown, cmd: Command) => {
    const ctx = getCtx(cmd);
    const rows = await ctx.makeClient().get<Array<Record<string, unknown>>>('management', PK);
    ctx.out.result({ providers: rows }, () => ctx.out.table(rows, [{ key: 'id' }, { key: 'provider' }, { key: 'label', format: (v) => String(v ?? '–') }, { key: 'priority', format: (v) => String(v ?? '–') }, { key: 'status', format: (v) => String(v ?? '–') }]));
  });
  providers.command('add <provider>').description('Add a key, read from stdin so it stays out of shell history')
    .option('--label <label>', 'a name for this key').option('--priority <n>', 'lower is tried first')
    .action(async (provider: string, o: { label?: string; priority?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const key = await readStdin();
      if (!key) throw new UsageError('No key on stdin.', 'Pipe it in: printf %s "$KEY" | tokenistt providers add openai');
      const r = await ctx.makeClient().post<{ id: string }>('management', PK, { provider, api_key: key, ...(o.label ? { label: o.label } : {}), ...(o.priority ? { priority: Number(o.priority) } : {}) });
      ctx.out.result(r, () => ctx.out.success(`Added a ${provider} key (${r.id}).`));
    });
  providers.command('remove <id>').description('Remove a key')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      await ctx.makeClient().request('management', 'DELETE', `${PK}/${encodeURIComponent(id)}`);
      ctx.out.result({ removed: id }, () => ctx.out.success(`Removed ${id}.`));
    });

  const policy = program.command('policy').description('Governance policies. They are enforced by the gateway, on requests that go through it');
  const P = '/v1/admin/policies';
  policy.action(async (_o: unknown, cmd: Command) => {
    const ctx = getCtx(cmd);
    const rows = await ctx.makeClient().get<Array<{ id: string; name: string; is_enabled: boolean; actions: { effect: string }; conditions: unknown }>>('management', P);
    ctx.out.result({ policies: rows }, () => ctx.out.table(rows.map((p) => ({ name: p.name, on: p.is_enabled ? 'yes' : 'no', effect: p.actions?.effect ?? '–', when: JSON.stringify(p.conditions ?? {}) })), [{ key: 'name' }, { key: 'on' }, { key: 'effect' }, { key: 'when' }]));
  });
  policy.command('test').description('Check what the policies would do to a request. Changes nothing; exits 5 if it would be stopped')
    .requiredOption('--model <model>', 'the model being requested').option('--project <project>').option('--team <team>').option('--feature <feature>')
    .action(async (o: { model: string; project?: string; team?: string; feature?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const r = await ctx.makeClient().post<{ allowed: boolean; code: string | null; reason: string | null; matched_policy: string | null; model_after_policies: string }>('management', `${P}/test`, { model: o.model, attribution: { ...(o.project ? { project: o.project } : {}), ...(o.team ? { team: o.team } : {}), ...(o.feature ? { feature: o.feature } : {}) } });
      ctx.out.result(r, () => {
        ctx.out.line(r.allowed ? `Allowed${r.model_after_policies !== o.model ? `, rerouted to ${r.model_after_policies}` : ''}.` : `Stopped: ${r.code}${r.reason ? ` (${r.reason})` : ''}.`);
        if (r.matched_policy) ctx.out.line(`Policy: ${r.matched_policy}`);
      });
      if (!r.allowed) process.exitCode = 5;
    });
  const PolicyFile = z.object({ policies: z.array(z.object({ name: z.string().min(1), description: z.string().optional(), enabled: z.boolean().optional(), conditions: z.record(z.string(), z.unknown()).optional(), actions: z.object({ effect: z.enum(['allow', 'block', 'force_model', 'require_approval']) }).catchall(z.unknown()) }).strict()) }).strict();
  policy.command('apply <file>').description('Create the policies in a YAML file. Shows the plan unless you pass --yes. Existing names are left unchanged')
    .option('--yes', 'make the changes')
    .action(async (file: string, o: { yes?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      let parsed: z.infer<typeof PolicyFile>;
      try {
        parsed = PolicyFile.parse(parseYaml(readFileSync(file, 'utf8')));
      } catch (err) {
        throw new CliError(`${file} is not a valid policy file: ${err instanceof z.ZodError ? err.issues[0]?.message : err instanceof Error ? err.message : String(err)}`, 2);
      }
      const client = ctx.makeClient();
      const existing = new Set((await client.get<Array<{ name: string }>>('management', P)).map((p) => p.name));
      const toCreate = parsed.policies.filter((p) => !existing.has(p.name));
      const skipped = parsed.policies.filter((p) => existing.has(p.name)).map((p) => p.name);
      if (!o.yes) {
        ctx.out.result({ dry_run: true, create: toCreate.map((p) => p.name), unchanged: skipped }, () => {
          ctx.out.line(`Would create: ${toCreate.map((p) => p.name).join(', ') || 'nothing'}.`);
          if (skipped.length) ctx.out.line(`Already exist, unchanged: ${skipped.join(', ')}.`);
          ctx.out.info('Run again with --yes to apply.');
        });
        return;
      }
      for (const p of toCreate) await client.post('management', P, { name: p.name, description: p.description, is_enabled: p.enabled, conditions: p.conditions ?? {}, actions: p.actions });
      ctx.out.result({ created: toCreate.map((p) => p.name), unchanged: skipped }, () => ctx.out.success(`Created ${toCreate.length}. ${skipped.length} left unchanged.`));
    });

  dates(program.command('optimize').description('Rules-based suggestions from your real usage. It suggests; it never changes anything'))
    .action(async (o: { days?: string; since?: string; until?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const client = ctx.makeClient();
      const [s, catalog] = await Promise.all([client.get<Summary>('management', '/v1/admin/usage/summary', { query: { group_by: 'model', ...period(o) } }), client.get<ModelInfo[]>('management', '/v1/admin/models')]);
      const findings = findOptimizations(s.rows, catalog);
      ctx.out.result({ findings }, () => {
        if (!findings.length) {
          ctx.out.line(s.rows.length ? 'Nothing stands out in this period.' : 'No usage in this period, so there is nothing to base suggestions on.');
          return;
        }
        for (const f of findings) {
          ctx.out.line(ctx.out.bold(f.title));
          ctx.out.line(`  Seen:       ${f.evidence}`);
          ctx.out.line(`  Try:        ${f.suggestion}`);
          ctx.out.line(`  Trade-off:  ${f.tradeoff}`);
          if (f.savingsUsd) ctx.out.line(`  Could save: $${f.savingsUsd.low.toFixed(2)} to $${f.savingsUsd.high.toFixed(2)} over this period, if a quarter to three quarters of the traffic could move`);
          ctx.out.line(`  Confidence: ${f.confidence}`);
          ctx.out.line();
        }
      });
    });
}
