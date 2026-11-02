import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { motionAllowed, Progress } from '../core/progress.js';
import { openDatabase } from '../store/db.js';
import { requireProject } from '../store/project.js';
import type { Context } from '../context.js';
import type { GraphMetadata } from '../graph/store.js';

type GetCtx = (cmd: Command) => Context;

function renderStats(ctx: Context, m: GraphMetadata): void {
  const { out } = ctx;
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  out.line(`${out.bold(m.repository.name)}  ${m.repository.branch ?? '(no branch)'}  ${m.repository.commit?.slice(0, 7) ?? '(no commits)'}`);
  out.line(`Generated ${m.generatedAt} in ${m.durationMs} ms`);
  out.line(`Files: ${m.files.total} (${m.files.parsed} parsed, ${m.files.reused} unchanged, ${m.files.skipped} skipped, ${m.files.parseErrors} with syntax errors)`);
  out.line();
  const rows = (o: Record<string, number>) => Object.entries(o).map(([name, count]) => ({ name, count }));
  out.line(out.bold(`Nodes: ${sum(m.nodes)}`));
  out.table(rows(m.nodes), [{ key: 'name', header: 'type' }, { key: 'count', align: 'right' }]);
  out.line();
  out.line(out.bold(`Relationships: ${sum(m.edges)}`));
  out.table(rows(m.edges), [{ key: 'name', header: 'type' }, { key: 'count', align: 'right' }]);
  out.line();
  const l = m.links;
  out.line(`Imports: ${l.importsResolved} resolved, ${l.importsExternal} external, ${l.importsUnresolved} unresolved`);
  out.line(`Calls:   ${l.callsResolved} resolved, ${l.callsUnresolved} not linked (external or dynamic; never guessed)`);
}

export function registerMap(program: Command, getCtx: GetCtx): void {
  program
    .command('map')
    .description('Build the codebase knowledge graph in .tokenistt/graph. Needs no network')
    .option('--full', 'analyze every file again, ignoring cached results')
    .option('--export <format>', 'also write nodes and edges as separate files (json)')
    .option('--out <dir>', 'directory for --export (default .tokenistt/exports)')
    .option('--stats', 'print statistics for the existing graph without rebuilding it')
    .action(async (o: { full?: boolean; export?: string; out?: string; stats?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      if (o.export && o.export !== 'json') throw new UsageError(`Unknown export format "${o.export}".`, 'Supported: json.');
      const project = requireProject(process.cwd());
      // Loaded here because tree-sitter is not needed by any other command.
      const { indexProject } = await import('../graph/indexer.js');
      const store = await import('../graph/store.js');
      const db = openDatabase(project.repo.root);
      try {
        if (o.stats) {
          const m = store.readMetadata(db);
          if (!m) throw new UsageError('There is no graph yet.', 'Run `tokenistt map` first.');
          ctx.out.result(m, () => renderStats(ctx, m));
          return;
        }
        const progress = new Progress({ silent: ctx.out.json || ctx.out.quiet, motion: motionAllowed(ctx.env, process.stderr.isTTY), color: ctx.out.color });
        let open = false;
        try {
          const { doc, metadata } = await indexProject(project, db, {
            full: o.full,
            progress: {
              phase: (label) => {
                if (open) progress.succeed();
                progress.start(label);
                open = true;
              },
              count: (done, total) => progress.update(done, total),
            },
          });
          progress.succeed();
          open = false;
          const exported = o.export ? store.exportJson(project.repo.root, doc, o.out) : [];
          progress.stop();
          ctx.out.result({ ...metadata, exported }, () => {
            renderStats(ctx, metadata);
            for (const f of exported) ctx.out.info(`Wrote ${f}`);
          });
        } catch (err) {
          if (open) progress.fail();
          throw err;
        } finally {
          progress.stop();
        }
      } finally {
        db.close();
      }
    });
}
