import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { analyzeGraph, traceRoute } from '../graph/analysis.js';
import { GraphIndex } from '../graph/query.js';
import { readEdges, readMetadata, readNodes } from '../graph/store.js';
import { refresh } from '../agents/sessions.js';
import { httpEmbedder, readEmbeddingConfig, search, updateEmbeddings } from '../retrieval/engine.js';
import { openDatabase } from '../store/db.js';
import { requireProject } from '../store/project.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

export function registerSearch(program: Command, getCtx: GetCtx): void {
  program
    .command('search <query>')
    .description('Find code, memories and sessions related to a question. Uses embeddings only if you configured them')
    .option('--limit <n>', 'how many results', '15')
    .action(async (query: string, o: { limit: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const project = requireProject(process.cwd());
      const db = openDatabase(project.repo.root);
      try {
        refresh(project.repo.root, db);
        const index = readMetadata(db) ? GraphIndex.load(db) : undefined;
        const cfg = readEmbeddingConfig(ctx.env);
        const r = await search(db, index, query, { limit: Number(o.limit) || 15, ...(cfg ? { embed: httpEmbedder(cfg, ctx.env), model: cfg.model } : {}) });
        ctx.out.result(r, () => {
          if (!r.hits.length) {
            ctx.out.line(`Nothing found for "${query}".`);
            if (!index) ctx.out.info('Run `tokenistt map` to include code.');
            return;
          }
          for (const h of r.hits) {
            ctx.out.line(`${h.title}`);
            ctx.out.line(ctx.out.dim(`  ${h.detail ? `${h.detail}  ` : ''}found by ${h.signals.join(', ')}`));
          }
          if (!r.semantic) ctx.out.info(ctx.out.dim('\nMatched on names and text. Semantic search is off; see `tokenistt embeddings`.'));
        });
      } finally {
        db.close();
      }
    });

  program
    .command('embeddings')
    .description('Build vectors for semantic search, using the endpoint in your intelligence.json. Sends names and paths only, never source code')
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const cfg = readEmbeddingConfig(ctx.env);
      if (!cfg) throw new UsageError('No embedding provider is configured. Semantic search is optional.', 'Add { "embeddings": { "baseUrl": "http://localhost:11434/v1", "model": "nomic-embed-text" } } to intelligence.json in your Tokenistt config folder.');
      const project = requireProject(process.cwd());
      const db = openDatabase(project.repo.root);
      try {
        if (!readMetadata(db)) throw new UsageError('There is no graph yet.', 'Run `tokenistt map` first.');
        const r = await updateEmbeddings(db, GraphIndex.load(db), httpEmbedder(cfg, ctx.env), cfg.model);
        ctx.out.result(r, () => ctx.out.success(`${r.embedded} embedded, ${r.reused} unchanged, using ${cfg.model} at ${cfg.baseUrl}.`));
      } finally {
        db.close();
      }
    });

  program
    .command('analyze')
    .description('Structure of the codebase: circular imports, isolated files, coupling, boundaries, entry points, possible duplicates')
    .option('--trace <route>', 'follow one API route to the tables it reaches, e.g. "GET /users"')
    .action((o: { trace?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const project = requireProject(process.cwd());
      const db = openDatabase(project.repo.root);
      try {
        if (!readMetadata(db)) throw new UsageError('There is no graph yet.', 'Run `tokenistt map` first.');
        const nodes = readNodes(db);
        const edges = readEdges(db);
        const { out } = ctx;
        if (o.trace) {
          const q = o.trace.toLowerCase();
          const matches = nodes.filter((n) => n.type === 'endpoint' && n.name.toLowerCase().includes(q));
          const exact = matches.filter((n) => n.name.toLowerCase() === q);
          const pick = exact.length ? exact : matches;
          if (pick.length === 0) throw new UsageError(`No API route matches "${o.trace}".`);
          if (pick.length > 1 && !exact.length) throw new UsageError(`"${o.trace}" matches ${pick.length} routes.`, pick.slice(0, 6).map((n) => n.name).join(', '));
          const t = traceRoute(pick[0] as (typeof nodes)[number], new Map(nodes.map((n) => [n.id, n])), edges);
          out.result(t, () => {
            out.line(`${out.bold(t.route)}  ${out.dim(t.path)}`);
            for (const s of t.steps) out.line(`${'  '.repeat(s.depth)}${s.name}  ${out.dim(s.where)}`);
            out.line();
            out.line(t.tables.length ? `Tables: ${t.tables.map((x) => `${x.name} (${x.access})`).join(', ')}` : 'No table access found.');
            out.line(out.dim('Calls are matched by name, so a dynamic call or an instance method may be missing.'));
          });
          return;
        }
        const a = analyzeGraph(nodes, edges);
        out.result(a, () => {
          const head = (t: string, n: number) => { out.line(); out.line(out.bold(`${t} (${n})`)); };
          head('Circular imports', a.cycles.length);
          for (const c of a.cycles.slice(0, 10)) out.line(`  ${c.join(' <-> ')}`);
          head('Highly coupled files', a.coupled.length);
          for (const c of a.coupled.slice(0, 10)) out.line(`  ${c.path}  ${out.dim(`imported by ${c.fanIn}, imports ${c.fanOut}`)}`);
          head('Connections between areas', a.boundaries.length);
          for (const b of a.boundaries.slice(0, 12)) out.line(`  ${b.from} -> ${b.to}  ${out.dim(`${b.imports} imports`)}`);
          head('Likely entry points', a.entryPoints.length);
          for (const e of a.entryPoints.slice(0, 12)) out.line(`  ${e}`);
          head('Isolated files', a.isolated.length);
          for (const f of a.isolated.slice(0, 12)) out.line(`  ${f}`);
          head('Possible duplicates: same name and length, worth checking', a.duplicates.length);
          for (const d of a.duplicates.slice(0, 10)) out.line(`  ${d.name}  ${out.dim(d.locations.join(', '))}`);
          out.line();
          out.line(out.dim('Isolated means no import links were found. It may still be used dynamically.'));
        });
      } finally {
        db.close();
      }
    });
}
