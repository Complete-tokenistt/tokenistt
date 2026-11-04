import { homedir } from 'node:os';
import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { confirm } from '../core/prompt.js';
import { isConnected, previewDiff } from '../agents/connect.js';
import { ADAPTERS, adapterFor } from '../agents/registry.js';
import { refresh } from '../agents/sessions.js';
import { buildContext, DEFAULT_MAX_TOKENS, toMarkdown } from '../context/engine.js';
import { AGENT_BUDGET, applyInject, planInject, planRemove } from '../context/inject.js';
import { extractMemories } from '../memory/extract.js';
import { openDatabase } from '../store/db.js';
import { requireProject } from '../store/project.js';
import type { AgentId } from '../agents/schemas.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

function parseBudget(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 100) throw new UsageError(`Invalid --max-tokens "${v}".`, 'Use a whole number of at least 100.');
  return n;
}

export function registerContext(program: Command, getCtx: GetCtx): void {
  const context = program.command('context').description('Generate what an agent should know about this project and the task at hand')
    .option('--task <task>', 'what you are about to do (default: taken from the active session)')
    .option('--max-tokens <n>', `approximate size limit (default ${DEFAULT_MAX_TOKENS})`)
    .option('--format <format>', 'markdown or json', 'markdown');

  context.action((o: { task?: string; maxTokens?: string; format: string }, cmd: Command) => {
    const ctx = getCtx(cmd);
    if (o.format !== 'markdown' && o.format !== 'json') throw new UsageError(`Unknown format "${o.format}".`, 'Use markdown or json.');
    const project = requireProject(process.cwd());
    const db = openDatabase(project.repo.root);
    try {
      extractMemories(project, db);
      const pkg = buildContext(project, db, { task: o.task, maxTokens: parseBudget(o.maxTokens, DEFAULT_MAX_TOKENS) });
      if (o.format === 'json' || ctx.out.json) ctx.out.line(JSON.stringify(pkg, null, 2));
      else process.stdout.write(toMarkdown(pkg));
    } finally {
      db.close();
    }
  });

  context.command('preview').description('Show what an agent would receive, changing nothing')
    .option('--agent <agent>', 'use this agent\'s size limit')
    .action((o: { agent?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const opts = cmd.optsWithGlobals() as { task?: string; maxTokens?: string };
      const agent = o.agent ? adapterFor(o.agent).id : undefined;
      const project = requireProject(process.cwd());
      const db = openDatabase(project.repo.root);
      try {
        refresh(project.repo.root, db);
        const pkg = buildContext(project, db, { task: opts.task, maxTokens: parseBudget(opts.maxTokens, agent ? AGENT_BUDGET[agent] : DEFAULT_MAX_TOKENS) });
        ctx.out.result(pkg, () => {
          process.stdout.write(toMarkdown(pkg));
          ctx.out.info('');
          ctx.out.info(`About ${pkg.budget.used} of ${pkg.budget.max} tokens (an estimate).`);
        });
      } finally {
        db.close();
      }
    });

  context.command('inject').description("Make context available to agents through what each supports. Never overwrites a file you wrote")
    .option('--agent <agent>', 'one agent (default: every connected agent)')
    .option('--merge', 'instead, add a marked block to the shared instruction file (CLAUDE.md or AGENTS.md)')
    .option('--remove', 'remove the marked block again')
    .option('--yes', 'make changes to shared files without asking')
    .option('--dry-run', 'show the change and stop')
    .action(async (o: { agent?: string; merge?: boolean; remove?: boolean; yes?: boolean; dryRun?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const opts = cmd.optsWithGlobals() as { task?: string; maxTokens?: string };
      const project = requireProject(process.cwd());
      const { root } = project.repo;
      const home = ctx.env.TOKENISTT_HOME ?? homedir();
      const connected = ADAPTERS.filter((a) => a.hookTargets(root, home).some((t) => isConnected(a, t)));
      const adapters = o.agent ? [adapterFor(o.agent)] : connected;
      if (adapters.length === 0) throw new UsageError('No agent is connected, so nothing would read the context.', 'Connect one with `tokenistt agents connect <agent>`, or name one with --agent.');
      const db = openDatabase(root);
      try {
        extractMemories(project, db);
        const results: Array<{ agent: AgentId; kind: string; file: string; changed: boolean; note?: string }> = [];
        for (const adapter of adapters) {
          const agent = adapter.id;
          const pkg = buildContext(project, db, { task: opts.task, maxTokens: parseBudget(opts.maxTokens, AGENT_BUDGET[agent]) });
          const plans = o.remove ? planRemove(root, agent) : [planInject(root, agent, toMarkdown(pkg), !!o.merge)];
          for (const plan of plans) {
            if (!plan.changed) {
              results.push({ agent, kind: plan.kind, file: plan.file, changed: false });
              continue;
            }
            const diff = previewDiff(plan.before, plan.after);
            // Files Tokenistt owns can be rewritten freely. A shared file needs a yes.
            if (o.dryRun) {
              ctx.out.result({ agent, file: plan.file, dry_run: true, diff }, () => {
                ctx.out.line(`Would change ${plan.file}:`);
                ctx.out.line(diff);
              });
              continue;
            }
            if (plan.kind === 'merge' && !o.yes) {
              if (!process.stdin.isTTY) throw new UsageError(`This changes ${plan.file}, and there is no terminal to ask for confirmation.`, 'Pass --dry-run to see the change, or --yes to make it.');
              ctx.out.line(`This changes ${plan.file}:`);
              ctx.out.line(diff);
              if (!(await confirm('Make this change?'))) {
                results.push({ agent, kind: plan.kind, file: plan.file, changed: false, note: 'declined' });
                continue;
              }
            }
            applyInject(plan);
            const note = plan.kind === 'hook' && !connected.includes(adapter) ? `Run \`tokenistt agents connect ${agent}\` so ${adapter.displayName} receives it.` : undefined;
            results.push({ agent, kind: plan.kind, file: plan.file, changed: true, ...(note ? { note } : {}) });
          }
        }
        if (o.dryRun) return;
        ctx.out.result({ results }, () => {
          if (results.length === 0) ctx.out.info('Nothing to remove.');
          for (const r of results) {
            ctx.out.success(`${r.agent}: ${r.changed ? 'updated' : 'unchanged'} ${r.file}${r.kind === 'hook' ? ' (handed over when a session starts)' : ''}`);
            if (r.note) ctx.out.warn(r.note);
          }
          if (results.length) ctx.out.info('This is a snapshot. Run it again, or after `tokenistt memory update`, to refresh it.');
        });
      } finally {
        db.close();
      }
    });
}
