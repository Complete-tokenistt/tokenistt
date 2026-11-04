import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { GraphIndex } from '../graph/query.js';
import { readMetadata } from '../graph/store.js';
import { analyzeImpact, changesAgainst, changesSince, describeChanges, resolveTarget, stagedFiles, workingChanges, type ChangedFile, type ImpactEntry, type ImpactReport } from '../impact/analyze.js';
import { refresh } from '../agents/sessions.js';
import { openDatabase, type Database } from '../store/db.js';
import { requireProject, type Project } from '../store/project.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

function requireGraph(db: Database): GraphIndex {
  if (!readMetadata(db)) throw new UsageError('There is no graph yet.', 'Run `tokenistt map` first.');
  return GraphIndex.load(db);
}

/** A graph built from an older commit may miss what just changed, so the report says so. */
function freshnessNote(project: Project, db: Database): string | undefined {
  const built = readMetadata(db)?.repository.commit;
  const head = project.repo.commit;
  return built && head && built !== head ? `The graph was built at ${built.slice(0, 7)} and HEAD is ${head.slice(0, 7)}. Run \`tokenistt map\` for current results.` : undefined;
}

const where = (e: ImpactEntry): string => (e.path ? `${e.path}${e.line ? `:${e.line}` : ''}` : '');
const certainty = (e: ImpactEntry): string => (e.confidence < 1 ? ` (inferred, ${Math.round(e.confidence * 100)}%)` : '');

function renderEntries(ctx: Context, title: string, entries: ImpactEntry[], limit: number): void {
  if (!entries.length) return;
  ctx.out.line();
  ctx.out.line(ctx.out.bold(`${title} (${entries.length})`));
  for (const e of entries.slice(0, limit)) ctx.out.line(`  ${e.name}  ${ctx.out.dim(`${where(e)}${certainty(e)}`)}`);
  if (entries.length > limit) ctx.out.line(ctx.out.dim(`  and ${entries.length - limit} more; use --json for all of them`));
}

function renderImpact(ctx: Context, r: ImpactReport): void {
  const { out } = ctx;
  out.line(`${out.bold('Impact of changing')} ${r.targets.map((t) => t.path && t.type !== 'file' ? `${t.name} in ${t.path}` : t.path ?? t.name).join(', ')}`);
  if (r.graphNote) out.warn(r.graphNote);
  out.line(`${r.direct.length} direct and ${r.indirect.length} indirect dependents, ${r.apis.length} API routes, ${r.tests.length} tests, ${r.tables.length} tables.`);
  out.line(out.dim('This is what is connected, not a prediction of what will break.'));
  renderEntries(ctx, 'Depends on it directly', r.direct, 20);
  renderEntries(ctx, 'Depends on it indirectly', r.indirect, 15);
  renderEntries(ctx, 'API routes that reach it', r.apis, 15);
  if (r.tables.length) {
    out.line();
    out.line(out.bold(`Database tables (${r.tables.length})`));
    for (const t of r.tables.slice(0, 15)) out.line(`  ${t.name}  ${out.dim(`${t.access}, from ${t.from}`)}`);
  }
  out.line();
  if (r.tests.length) {
    out.line(out.bold(`Tests to run (${r.tests.length})`));
    for (const t of r.tests.slice(0, 15)) out.line(`  ${t.path}${t.depth > 1 ? out.dim(`  ${t.depth} steps away`) : ''}`);
  } else {
    out.line(out.bold('No test found that reaches this.'));
  }
  if (r.breaking.length) {
    out.line();
    out.line(out.bold('Exported and in use, so a signature change would reach these'));
    for (const b of r.breaking.slice(0, 12)) out.line(`  ${b.symbol}  ${out.dim(`used in ${b.usedBy} place${b.usedBy === 1 ? '' : 's'}: ${b.usedByFiles.slice(0, 3).join(', ')}`)}`);
  }
  if (r.modules.length) {
    out.line();
    out.line(`${out.bold('Modules:')} ${r.modules.join(', ')}`);
  }
  if (r.decisions.length) {
    out.line();
    out.line(out.bold('Related decisions'));
    for (const d of r.decisions) out.line(`  ${d.content}${d.stale ? ' (may be out of date)' : ''}  ${out.dim(`[${d.source}]`)}`);
  }
}

export function registerImpact(program: Command, getCtx: GetCtx): void {
  program
    .command('impact [target]')
    .description('What could be affected by changing a file or symbol. Needs a graph from `tokenistt map`')
    .option('--staged', 'the files staged for commit')
    .option('--depth <n>', 'how many steps to follow', '4')
    .action((target: string | undefined, o: { staged?: boolean; depth: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      if (target && o.staged) throw new UsageError('Give a target or --staged, not both.');
      if (!target && !o.staged) throw new UsageError('What should be analyzed?', 'Name a file or symbol, or use --staged.');
      const depth = Number(o.depth);
      if (!Number.isInteger(depth) || depth < 1 || depth > 20) throw new UsageError(`Invalid --depth "${o.depth}".`, 'Use a whole number from 1 to 20.');
      const project = requireProject(process.cwd());
      const db = openDatabase(project.repo.root);
      try {
        const index = requireGraph(db);
        let targets: string[];
        const unknown: string[] = [];
        if (o.staged) {
          const staged = stagedFiles(project.repo.root);
          if (staged.length === 0) {
            ctx.out.result({ targets: [], staged: 0 }, () => ctx.out.line('Nothing is staged.'));
            return;
          }
          targets = [];
          for (const f of staged) {
            if (index.nodes.has(`file:${f.path}`)) targets.push(`file:${f.path}`);
            else unknown.push(f.path);
          }
          if (targets.length === 0) {
            ctx.out.result({ targets: [], unknown }, () => ctx.out.line(`None of the staged files are in the graph yet: ${unknown.join(', ')}. Run \`tokenistt map\`.`));
            return;
          }
        } else {
          targets = [resolveTarget(index, target as string)];
        }
        const report = analyzeImpact(index, db, targets, { maxDepth: depth });
        const graphNote = freshnessNote(project, db);
        if (graphNote) report.graphNote = graphNote;
        ctx.out.result({ ...report, ...(unknown.length ? { notInGraph: unknown } : {}) }, () => {
          renderImpact(ctx, report);
          if (unknown.length) ctx.out.warn(`Not in the graph yet, so not analyzed: ${unknown.join(', ')}.`);
        });
      } finally {
        db.close();
      }
    });

  program
    .command('changes')
    .description('What changed, and what deserves a closer look. Works without a graph, with less detail')
    .option('--since <rev>', 'commits since this revision, e.g. HEAD~5')
    .option('--compare <ref>', 'this branch against another, e.g. main')
    .action((o: { since?: string; compare?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      if (o.since && o.compare) throw new UsageError('Use --since or --compare, not both.');
      const project = requireProject(process.cwd());
      const { root } = project.repo;
      const db = openDatabase(root);
      try {
        refresh(root, db);
        let files: ChangedFile[];
        let label: string;
        try {
          if (o.since) { files = changesSince(root, o.since); label = `since ${o.since}`; }
          else if (o.compare) { files = changesAgainst(root, o.compare); label = `compared with ${o.compare}`; }
          else { files = workingChanges(root); label = 'not yet committed'; }
        } catch (err) {
          if (err instanceof UsageError) throw err;
          throw new UsageError(`Git could not read "${o.since ?? o.compare}".`, 'Check that the revision exists.');
        }
        const index = readMetadata(db) ? GraphIndex.load(db) : undefined;
        const rows = describeChanges(files, index, db, root);
        const note = index ? freshnessNote(project, db) : 'There is no graph yet, so dependents and tests are unknown. Run `tokenistt map`.';
        ctx.out.result({ scope: label, files: rows, ...(note ? { note } : {}) }, () => {
          const { out } = ctx;
          if (rows.length === 0) {
            out.line(`No changes ${label}.`);
            return;
          }
          out.line(`${out.bold(`${rows.length} file${rows.length === 1 ? '' : 's'} changed`)} ${label}`);
          if (note) out.warn(note);
          out.line();
          const unknown = (v: number | null) => (v === null ? 'unknown' : String(v));
          out.table(rows.map((r) => ({ file: r.from ? `${r.from} -> ${r.path}` : r.path, status: r.status, dependents: unknown(r.dependents), tests: unknown(r.tests), commits: r.commitsTouching, agent: r.agentSessions.length ? r.agentSessions[0] ?? '' : '–' })), [
            { key: 'file' }, { key: 'status' }, { key: 'dependents', align: 'right' }, { key: 'tests', align: 'right' }, { key: 'commits', header: 'recent commits', align: 'right' }, { key: 'agent', header: 'agent session' },
          ]);
          const flagged = rows.filter((r) => r.attention.length);
          if (flagged.length) {
            out.line();
            out.line(out.bold('Worth a closer look'));
            for (const r of flagged) out.line(`  ${r.path}: ${r.attention.join('; ')}`);
          }
          if (rows.some((r) => r.agentSessions.length)) {
            out.line();
            out.line(out.dim('An agent session is listed if it edited that path. That does not mean it made this exact change.'));
          }
        });
      } finally {
        db.close();
      }
    });
}
