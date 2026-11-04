import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { openDatabase } from '../store/db.js';
import { requireProject } from '../store/project.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

/** Fixed programs with the viewer's own URL as the only argument, and no shell parsing it on POSIX. */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] as const
    : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const;
  const child = spawn(cmd, [...args], { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
  child.on('error', () => { /* The URL is printed, so a missing opener is not a failure. */ });
  child.unref();
}

export function registerGraph(program: Command, getCtx: GetCtx): void {
  program
    .command('graph')
    .description('Explore the codebase graph: a summary here, or the full interactive view with --open')
    .option('--open', 'start the local viewer and open it in your browser')
    .option('--no-browser', 'with --open: print the URL without launching a browser')
    .option('--port <port>', 'with --open: port to listen on (default: any free port)')
    .action(async (o: { open?: boolean; browser?: boolean; port?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const project = requireProject(process.cwd());
      const { GraphIndex } = await import('../graph/query.js');
      const store = await import('../graph/store.js');
      const db = openDatabase(project.repo.root);
      try {
        const metadata = store.readMetadata(db);
        if (!metadata) throw new UsageError('There is no graph yet.', 'Run `tokenistt map` first.');
        const index = GraphIndex.load(db);

        if (!o.open) {
          const top = index.childrenOf('dir:.', 12);
          const used = index.mostUsed(8);
          const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
          ctx.out.result({ metadata, top: top.items, mostUsed: used }, () => {
            const { out } = ctx;
            out.line(`${out.bold(metadata.repository.name)}  ${sum(metadata.nodes)} nodes, ${sum(metadata.edges)} relationships, updated ${metadata.generatedAt}`);
            out.line();
            out.line(out.bold('Largest areas'));
            out.table(top.items, [{ key: 'name' }, { key: 'type' }, { key: 'descendants', header: 'nodes', align: 'right' }]);
            if (top.total > top.items.length) out.line(out.dim(`and ${top.total - top.items.length} more`));
            out.line();
            out.line(out.bold('Most depended on'));
            out.table(used, [{ key: 'name' }, { key: 'type' }, { key: 'dependents', align: 'right' }, { key: 'path', format: (v) => (v === undefined ? '–' : String(v)) }]);
            out.line();
            out.info('Run `tokenistt graph --open` to explore it interactively.');
          });
          return;
        }

        const port = o.port === undefined ? undefined : Number(o.port);
        if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError(`Invalid port "${o.port}".`);
        const { startViewer } = await import('../viewer/server.js');
        const { refresh, sessionsForPath } = await import('../agents/sessions.js');
        refresh(project.repo.root, db);
        const viewer = await startViewer({ index, metadata, root: project.repo.root, port, sessionsForPath: (path) => sessionsForPath(db, path) });
        ctx.out.result({ url: viewer.url, port: viewer.port }, () => {
          ctx.out.success(`Viewer running at ${viewer.url}`);
          ctx.out.info('Only this machine can reach it. Press Ctrl+C to stop.');
        });
        if (o.browser !== false) openBrowser(viewer.url);
        await new Promise<void>((resolve) => {
          process.once('SIGINT', resolve);
          process.once('SIGTERM', resolve);
        });
        await viewer.close();
      } finally {
        db.close();
      }
    });
}
