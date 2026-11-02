import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { motionAllowed, Progress } from '../core/progress.js';
import { openDatabase, type Database } from '../store/db.js';
import { requireProject, type Project } from '../store/project.js';
import { EXTRACTOR_VERSION } from '../graph/schema.js';
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

/** Runs until interrupted. In --json mode each update is one line, so the stream can be piped. */
async function watchLoop(ctx: Context, project: Project, db: Database, index: typeof import('../graph/indexer.js').indexProject): Promise<void> {
  const { watchFiles } = await import('../graph/watch.js');
  ctx.out.info('Watching for changes. Press Ctrl+C to stop.');
  const handle = watchFiles({
    root: project.repo.root,
    exclude: project.config.index.exclude,
    onChange: async (changed) => {
      const { metadata } = await index(project, db);
      if (ctx.out.json) ctx.out.line(JSON.stringify({ changed, files: metadata.files, durationMs: metadata.durationMs }));
      else ctx.out.info(`${changed.length} changed: re-parsed ${metadata.files.parsed}, reused ${metadata.files.reused} in ${metadata.durationMs} ms`);
    },
    onError: (err) => ctx.out.warn(`Could not update the graph: ${err instanceof Error ? err.message : String(err)}`),
  });
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  handle.close();
  await handle.idle();
}

export function registerMap(program: Command, getCtx: GetCtx): void {
  program
    .command('map')
    .description('Build the codebase knowledge graph in .tokenistt/graph. Needs no network')
    .option('--full', 'analyze every file again, ignoring cached results')
    .option('--incremental', 'reuse results for unchanged files (the default; fails if no graph exists yet)')
    .option('--watch', 'stay running and update the graph when files change')
    .option('--import <file>', 'replace the graph with one exported from `tokenistt map`')
    .option('--export <format>', 'also write nodes and edges as separate files (json)')
    .option('--out <dir>', 'directory for --export (default .tokenistt/exports)')
    .option('--stats', 'print statistics for the existing graph without rebuilding it')
    .action(async (o: { full?: boolean; incremental?: boolean; watch?: boolean; import?: string; export?: string; out?: string; stats?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      if (o.export && o.export !== 'json') throw new UsageError(`Unknown export format "${o.export}".`, 'Supported: json.');
      if (o.full && o.incremental) throw new UsageError('--full and --incremental cannot be combined.');
      if (o.import && (o.full || o.incremental || o.watch || o.export)) throw new UsageError('--import cannot be combined with other map options.');
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
        if (o.import) {
          const { readGraphFile } = await import('../graph/export.js');
          const doc = readGraphFile(o.import);
          const counts = store.graphCounts(doc.nodes, doc.edges);
          store.saveImportedGraph(db, doc);
          const metadata: GraphMetadata = {
            schemaVersion: doc.schemaVersion, extractorVersion: EXTRACTOR_VERSION, repository: doc.repository, generatedAt: new Date().toISOString(), durationMs: 0, mode: 'imported',
            files: { total: counts.nodes.file ?? 0, parsed: 0, reused: 0, skipped: 0, parseErrors: 0 }, nodes: counts.nodes, edges: counts.edges, links: {}, languages: {},
          };
          store.saveMetadata(db, metadata);
          store.writeGraphFiles(project.repo.root, doc, metadata);
          ctx.out.result(metadata, () => {
            ctx.out.success(`Imported ${doc.nodes.length} nodes and ${doc.edges.length} relationships from ${o.import}.`);
            ctx.out.info('The next `tokenistt map` analyzes every file again and replaces this graph.');
          });
          return;
        }
        if (o.incremental && !store.readMetadata(db)) throw new UsageError('There is no graph to update yet.', 'Run `tokenistt map` first.');
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
          if (o.watch) await watchLoop(ctx, project, db, indexProject);
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
