import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { confirm } from '../core/prompt.js';
import { applyPlan, hookCommand, isConnected, planConnect, planDisconnect, previewDiff } from '../agents/connect.js';
import { ADAPTERS, adapterFor } from '../agents/registry.js';
import { CAPABILITY_KEYS } from '../agents/schemas.js';
import { projectDir, requireProject } from '../store/project.js';
import type { AgentAdapter, HookTarget } from '../agents/adapter.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

const homeOf = (env: NodeJS.ProcessEnv): string => env.TOKENISTT_HOME ?? homedir();

function targetFor(adapter: AgentAdapter, root: string, home: string, user: boolean | undefined): HookTarget {
  const scope = user ? 'user' : 'project';
  const target = adapter.hookTargets(root, home).find((t) => t.scope === scope);
  if (!target) throw new UsageError(`${adapter.displayName} has no ${scope} hook configuration.`);
  return target;
}

async function runChange(ctx: Context, adapter: AgentAdapter, target: HookTarget, plan: { before: string; after: string; changed: boolean }, verb: 'connect' | 'disconnect', o: { yes?: boolean; dryRun?: boolean }, root: string): Promise<boolean> {
  if (!plan.changed) {
    ctx.out.result({ agent: adapter.id, file: target.file, changed: false }, () => ctx.out.info(verb === 'connect' ? `${adapter.displayName} is already connected.` : `${adapter.displayName} is not connected in ${target.file}.`));
    return false;
  }
  const diff = previewDiff(plan.before, plan.after);
  if (o.dryRun) {
    ctx.out.result({ agent: adapter.id, file: target.file, changed: false, dry_run: true, diff }, () => {
      ctx.out.line(`Would change ${target.file}:`);
      ctx.out.line(diff);
    });
    return false;
  }
  if (!o.yes) {
    if (!process.stdin.isTTY) throw new UsageError(`This changes ${target.file}, and there is no terminal to ask for confirmation.`, 'Pass --dry-run to see the change, or --yes to make it.');
    ctx.out.line(`This changes ${target.file}:`);
    ctx.out.line(diff);
    if (!(await confirm(`${verb === 'connect' ? 'Connect' : 'Disconnect'} ${adapter.displayName}?`))) {
      ctx.out.info('Nothing was changed.');
      return false;
    }
  }
  const backup = applyPlan(target, plan.after, new Date(), target.scope === 'project' ? join(projectDir(root), 'backups') : undefined);
  ctx.out.result({ agent: adapter.id, file: target.file, changed: true, backup: backup ?? null }, () => {
    ctx.out.success(`${verb === 'connect' ? 'Connected' : 'Disconnected'} ${adapter.displayName} (${target.file}).`);
    if (backup) ctx.out.info(`Previous version saved as ${backup}`);
  });
  return true;
}

export function registerAgents(program: Command, getCtx: GetCtx): void {
  const agents = program.command('agents').description('Connect coding agents such as Claude Code so their sessions can be observed');

  agents.action((_o: unknown, cmd: Command) => {
    const ctx = getCtx(cmd);
    const project = requireProject(process.cwd());
    const home = homeOf(ctx.env);
    const rows = ADAPTERS.map((a) => {
      const install = a.detectInstallation(ctx.env, home);
      const connected = a.hookTargets(project.repo.root, home).filter((t) => isConnected(a, t)).map((t) => t.scope);
      return { agent: a.id, name: a.displayName, installed: install.installed, evidence: install.evidence ?? null, connected: connected.length ? connected.join(', ') : null, verification: a.verification };
    });
    ctx.out.result({ agents: rows }, () => {
      ctx.out.table(rows, [
        { key: 'name', header: 'agent' },
        { key: 'installed', format: (v) => (v ? 'yes' : 'no') },
        { key: 'connected', format: (v) => (v ? String(v) : 'no') },
      ]);
      ctx.out.info('');
      ctx.out.info('Connect one with `tokenistt agents connect <agent>`. See what each can report with `tokenistt agents capabilities`.');
    });
  });

  agents
    .command('connect <agent>')
    .description("Add Tokenistt's hooks to the agent's settings. Shows the change and asks first")
    .option('--user', 'all your repositories, rather than this one')
    .option('--yes', 'make the change without asking')
    .option('--dry-run', 'show the change and stop')
    .action(async (agent: string, o: { user?: boolean; yes?: boolean; dryRun?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const adapter = adapterFor(agent);
      const project = requireProject(process.cwd());
      const target = targetFor(adapter, project.repo.root, homeOf(ctx.env), o.user);
      const changed = await runChange(ctx, adapter, target, planConnect(adapter, target, hookCommand(adapter.id)), 'connect', o, project.repo.root);
      if (changed && adapter.afterConnect) ctx.out.info(adapter.afterConnect);
      if (changed) ctx.out.info('Start your agent as usual, then see it live with `tokenistt watch` (or `tokenistt sessions` afterwards).');
    });

  agents
    .command('disconnect <agent>')
    .description("Remove Tokenistt's hooks from the agent's settings, leaving everything else")
    .option('--user', 'the user-level settings, rather than this repository')
    .option('--yes', 'make the change without asking')
    .option('--dry-run', 'show the change and stop')
    .action(async (agent: string, o: { user?: boolean; yes?: boolean; dryRun?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const adapter = adapterFor(agent);
      const project = requireProject(process.cwd());
      const target = targetFor(adapter, project.repo.root, homeOf(ctx.env), o.user);
      await runChange(ctx, adapter, target, planDisconnect(adapter, target), 'disconnect', o, project.repo.root);
    });

  agents
    .command('capabilities')
    .description('What can actually be observed for each agent, and how')
    .action((_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const data = ADAPTERS.map((a) => ({ agent: a.id, verification: a.verification, capabilities: a.capabilities }));
      ctx.out.result({ agents: data }, () => {
        for (const a of ADAPTERS) {
          ctx.out.line(`${ctx.out.bold(a.displayName)}  ${a.verification === 'live' ? 'checked against the real agent' : 'from its documentation, not yet checked live'}`);
          ctx.out.table(CAPABILITY_KEYS.map((k) => ({ what: k, state: a.capabilities[k].state, how: a.capabilities[k].how })), [{ key: 'what' }, { key: 'state' }, { key: 'how' }]);
          ctx.out.line();
        }
      });
    });
}
