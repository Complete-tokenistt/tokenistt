import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { AuthError, UsageError } from '../core/errors.js';
import { buildPayload, runSync } from '../sync/sync.js';
import { openDatabase } from '../store/db.js';
import { projectDir, requireProject } from '../store/project.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

function setSync(root: string, patch: { enabled?: boolean; ledger?: boolean }): void {
  const file = join(projectDir(root), 'config.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as { sync?: Record<string, unknown> };
  cfg.sync = { ...cfg.sync, ...patch };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  renameSync(tmp, file);
}

export function registerSync(program: Command, getCtx: GetCtx): void {
  program
    .command('sync')
    .description('Send repository summaries to your gateway, for the dashboard. Off until you turn it on')
    .option('--enable', 'turn sync on for this repository')
    .option('--disable', 'turn sync off')
    .option('--ledger', 'also count agent usage toward budgets. For API-billed usage only')
    .option('--no-ledger', 'stop counting agent usage toward budgets')
    .option('--dry-run', 'show exactly what would be sent, and send nothing')
    .action(async (o: { enable?: boolean; disable?: boolean; ledger?: boolean; dryRun?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      if (o.enable && o.disable) throw new UsageError('Use --enable or --disable, not both.');
      let project = requireProject(process.cwd());
      const { root } = project.repo;
      if (o.enable || o.disable || o.ledger !== undefined) {
        setSync(root, { ...(o.enable || o.disable ? { enabled: !!o.enable } : {}), ...(o.ledger !== undefined ? { ledger: o.ledger } : {}) });
        project = requireProject(process.cwd());
        ctx.out.info(`Sync is ${project.config.sync.enabled ? 'on' : 'off'}. Agent usage ${project.config.sync.ledger ? 'counts' : 'does not count'} toward budgets.`);
        if (o.ledger) ctx.out.warn('Only use this for usage billed per token. Subscription usage would show as spend.');
        if (o.disable) return;
      }
      const db = openDatabase(root);
      try {
        if (o.dryRun) {
          const plan = buildPayload(project, db);
          ctx.out.line(JSON.stringify(plan.payload, null, 2));
          return;
        }
        if (!project.config.sync.enabled) throw new UsageError('Sync is off for this repository, so nothing was sent.', 'See what would be sent with --dry-run, and turn it on with --enable.');
        const client = ctx.makeClient();
        if (!client.hasKey) throw new AuthError('Sync needs a virtual API key.', 'Run `tokenistt login`, or set TOKENISTT_API_KEY.');
        const r = await runSync(project, db, client);
        ctx.out.result(r, () => {
          ctx.out.success(`Sent ${r.sessions} sessions, ${r.memories} memories${r.graph ? ' and the graph summary' : ''}.`);
          if (r.ledgerEvents) {
            const l = r.ledgerEvents;
            ctx.out.info(`Ledger: ${l.accepted} added, ${l.duplicate} already there, ${l.rejected} rejected, ${l.skippedProxied} skipped because they ran through this gateway, ${l.skippedNoModel} skipped with no model.`);
          }
        });
      } finally {
        db.close();
      }
    });
}
