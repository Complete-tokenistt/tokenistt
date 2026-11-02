import type { Command } from 'commander';
import { ExitCode } from '../core/errors.js';
import { connect, connectionStatus, disconnect } from '../services/connection.js';
import { runDoctor } from '../services/doctor.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

export function registerConnect(program: Command, getCtx: GetCtx): void {
  program
    .command('connect')
    .description('Verify the link to the gateway and discover your organization, workspaces and projects')
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const r = await connect(ctx.makeClient(), ctx.env);
      ctx.out.result(r, () => {
        ctx.out.success(`Connected to ${r.apiUrl} (${r.latencyMs} ms${r.health.database ? `, database ${r.health.database}` : ''})`);
        if (r.discovery) {
          const d = r.discovery;
          ctx.out.line(`${ctx.out.bold('Organization')}  ${d.organization.name} [${d.organization.slug}]  role: ${d.role}`);
          ctx.out.line(ctx.out.bold('Workspaces'));
          ctx.out.table(d.workspaces, [{ key: 'name' }, { key: 'cost_center', header: 'cost center' }]);
          ctx.out.line(ctx.out.bold('Projects'));
          ctx.out.table(d.projects, [{ key: 'name' }, { key: 'slug' }, { key: 'environment' }]);
        }
        if (r.note) ctx.out.warn(r.note);
      });
    });

  program
    .command('disconnect')
    .description('Forget the saved connection (credentials are kept; use `logout` to remove them)')
    .action((_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const r = disconnect(ctx.env);
      ctx.out.result({ ok: true, was_connected: r.wasConnected }, () => ctx.out.success(r.wasConnected ? 'Disconnected.' : 'There was no saved connection.'));
    });

  const connection = program.command('connection').description('Monitor the gateway connection');
  connection
    .command('status')
    .description('Probe the gateway now: connected, offline (exit 4) or unauthorized (exit 3)')
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const s = await connectionStatus(ctx.makeClient(), ctx.config);
      ctx.out.result(s, () => {
        const icon = s.state === 'connected' ? '●' : '○';
        ctx.out.line(`${icon} ${ctx.out.bold(s.state)}  ${s.apiUrl}${s.latencyMs !== undefined ? `  ${s.latencyMs} ms` : ''}`);
        if (s.organization) ctx.out.line(`  organization: ${s.organization}`);
        if (s.detail) ctx.out.line(`  ${s.detail}`);
      });
      if (s.state === 'offline') process.exitCode = ExitCode.Network;
      else if (s.state === 'unauthorized' || s.state === 'not_configured') process.exitCode = ExitCode.Auth;
    });

  program
    .command('doctor')
    .description('Check the installation, credentials, gateway and configuration')
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const report = await runDoctor({ cfg: ctx.config, client: ctx.makeClient(), nodeVersion: process.version, env: ctx.env });
      ctx.out.result(report, () => {
        const mark = { ok: '✔', warn: '!', fail: '✖', skip: '–' } as const;
        for (const c of report.checks) {
          ctx.out.line(`${mark[c.status]} ${ctx.out.bold(c.title)}  ${c.detail}`);
          if (c.fix && c.status !== 'ok') ctx.out.line(`    ${ctx.out.dim('→ ' + c.fix)}`);
        }
        ctx.out.line();
        ctx.out.line(`${report.summary.ok} ok, ${report.summary.warn} warnings, ${report.summary.fail} failed, ${report.summary.skip} skipped`);
      });
      if (!report.ok) process.exitCode = ExitCode.Error;
    });
}
