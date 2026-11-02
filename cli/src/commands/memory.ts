import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { UsageError } from '../core/errors.js';
import { extractMemories } from '../memory/extract.js';
import { CATEGORIES, editMemory, getMemory, linkedNodes, linkedSessions, listMemories, memoryHistory, memoryStats, parseCategory, remember, retireMemory, searchMemories, type Memory } from '../memory/store.js';
import { openDatabase, type Database } from '../store/db.js';
import { projectDir, requireProject, type Project } from '../store/project.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

function withProject<T>(fn: (project: Project, db: Database) => T): T {
  const project = requireProject(process.cwd());
  const db = openDatabase(project.repo.root);
  try {
    return fn(project, db);
  } finally {
    db.close();
  }
}

const label = (c: string): string => c.charAt(0) + c.slice(1).toLowerCase().replaceAll('_', ' ');
const source = (m: Memory): string => `${m.source_kind}: ${m.source_kind === 'commit' ? m.source_ref.slice(0, 7) : m.source_ref}`;

function renderList(ctx: Context, rows: Memory[]): void {
  let category = '';
  for (const m of rows) {
    if (m.category !== category) {
      category = m.category;
      ctx.out.line();
      ctx.out.line(ctx.out.bold(label(category)));
    }
    ctx.out.line(`  ${m.content}`);
    const flags = m.status !== 'active' ? `  ${m.status}${m.stale_reason ? `: ${m.stale_reason}` : ''}` : '';
    ctx.out.line(ctx.out.dim(`    ${m.id.slice(0, 12)}  from ${source(m)}${flags}`));
  }
}

function renderStats(ctx: Context, s: ReturnType<typeof memoryStats>): void {
  ctx.out.line(`${s.active} active, ${s.stale} stale, ${s.superseded} earlier versions, ${s.retired} retired. Last updated ${s.lastUpdated ?? 'never'}.`);
  ctx.out.line();
  ctx.out.table(Object.entries(s.byCategory).map(([k, c]) => ({ category: label(k), count: c })), [{ key: 'category' }, { key: 'count', align: 'right' }]);
}

function toMarkdown(rows: Memory[]): string {
  const out = ['# Project memory', ''];
  for (const c of CATEGORIES) {
    const inCategory = rows.filter((m) => m.category === c);
    if (!inCategory.length) continue;
    out.push(`## ${label(c)}`, '');
    for (const m of inCategory) out.push(`- ${m.content} _(from ${source(m)}${m.status === 'stale' ? '; stale' : ''})_`);
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

export function registerMemory(program: Command, getCtx: GetCtx): void {
  const memory = program.command('memory').description("What Tokenistt remembers about this project. Every entry says where it came from");

  memory.action((_o: unknown, cmd: Command) => {
    const ctx = getCtx(cmd);
    withProject((_p, db) => {
      const stats = memoryStats(db);
      ctx.out.result(stats, () => {
        if (stats.total === 0) {
          ctx.out.line('Nothing remembered yet.');
          ctx.out.info('Run `tokenistt memory update` to read sessions, commits, decision records and the graph.');
          return;
        }
        renderStats(ctx, stats);
        ctx.out.info('');
        ctx.out.info('See it with `tokenistt memory show`.');
      });
    });
  });

  memory.command('show').description('Current memories, by category')
    .option('--category <category>', `only one: ${CATEGORIES.join(', ')}`)
    .option('--all', 'also earlier versions and retired entries')
    .option('--id <id>', 'one memory in full, with what it links to')
    .action((o: { category?: string; all?: boolean; id?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      withProject((_p, db) => {
        if (o.id) {
          const m = getMemory(db, o.id);
          const detail = { ...m, nodes: linkedNodes(db, m.id), sessions: linkedSessions(db, m.id), versions: memoryHistory(db, m.id).map((v) => ({ id: v.id, status: v.status, created_at: v.created_at, content: v.content })) };
          ctx.out.result(detail, () => {
            ctx.out.line(ctx.out.bold(label(m.category)));
            ctx.out.line(m.content);
            ctx.out.line();
            ctx.out.line(`From:       ${source(m)}`);
            ctx.out.line(`Status:     ${m.status}${m.stale_reason ? ` (${m.stale_reason})` : ''}`);
            ctx.out.line(`Confidence: ${m.confidence}`);
            ctx.out.line(`Updated:    ${m.updated_at}`);
            if (detail.nodes.length) ctx.out.line(`About:      ${detail.nodes.slice(0, 8).join(', ')}${detail.nodes.length > 8 ? ` and ${detail.nodes.length - 8} more` : ''}`);
            if (detail.sessions.length) ctx.out.line(`Sessions:   ${detail.sessions.join(', ')}`);
            if (detail.versions.length > 1) {
              ctx.out.line();
              ctx.out.line(ctx.out.bold('Versions'));
              for (const v of detail.versions) ctx.out.line(`  ${v.created_at.slice(0, 10)}  ${v.status.padEnd(10)}  ${v.content}`);
            }
          });
          return;
        }
        const rows = listMemories(db, { category: o.category ? parseCategory(o.category) : undefined, includeInactive: o.all });
        rows.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || b.relevance - a.relevance);
        ctx.out.result({ memories: rows }, () => {
          if (rows.length === 0) {
            ctx.out.line('Nothing to show.');
            ctx.out.info('Run `tokenistt memory update` first.');
            return;
          }
          renderList(ctx, rows);
        });
      });
    });

  memory.command('search <query>').description('Find memories by words they contain')
    .action((query: string, _o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      withProject((_p, db) => {
        const rows = searchMemories(db, query);
        ctx.out.result({ memories: rows }, () => {
          if (rows.length === 0) {
            ctx.out.line(`Nothing mentions "${query}".`);
            return;
          }
          renderList(ctx, rows);
        });
      });
    });

  memory.command('update').description('Read new sessions, commits, decision records and the graph into memory. Safe to re-run')
    .action((_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      withProject((project, db) => {
        const r = extractMemories(project, db);
        // Plain files too, for anyone reading them without this CLI.
        const dir = join(projectDir(project.repo.root), 'memory');
        mkdirSync(dir, { recursive: true });
        const all = listMemories(db, { limit: 5000 });
        writeFileSync(join(dir, 'project-memory.json'), `${JSON.stringify(all, null, 2)}\n`);
        writeFileSync(join(dir, 'decisions.json'), `${JSON.stringify(all.filter((m) => m.category === 'ARCHITECTURAL_DECISIONS'), null, 2)}\n`);
        ctx.out.result(r, () => ctx.out.success(`${r.created} new, ${r.updated} changed, ${r.unchanged} unchanged, ${r.staled} marked stale, from ${r.sessions} finished sessions.`));
      });
    });

  memory.command('add <text>').description('Remember something yourself, such as a decision or an open task')
    .requiredOption('--category <category>', `one of: ${CATEGORIES.join(', ')}`)
    .option('--about <nodes...>', 'file paths or graph node ids this relates to')
    .action((text: string, o: { category: string; about?: string[] }, cmd: Command) => {
      const ctx = getCtx(cmd);
      withProject((project, db) => {
        const nodes = (o.about ?? []).map((a) => (a.includes(':') ? a : `file:${a.replaceAll('\\', '/')}`));
        const r = remember(db, project.config.projectId, { category: parseCategory(o.category), content: text, sourceKind: 'user', sourceRef: 'tokenistt memory add', confidence: 1, relevance: 0.85, nodes });
        ctx.out.result(r, () => ctx.out.success(`Remembered as ${r.id}.`));
      });
    });

  memory.command('edit <id> <text>').description('Change a memory. What it said before is kept as an earlier version')
    .action((id: string, text: string, _o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      withProject((_p, db) => {
        if (!text.trim()) throw new UsageError('The new text is empty.', 'To stop showing a memory, use `tokenistt memory forget`.');
        const next = editMemory(db, id, text);
        ctx.out.result({ id: next }, () => ctx.out.success(`Updated. The current version is ${next}.`));
      });
    });

  memory.command('forget <id>').description('Stop showing a memory. It stays in the history')
    .option('--reason <reason>', 'why', 'Retired by hand')
    .action((id: string, o: { reason: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      withProject((_p, db) => {
        const m = retireMemory(db, id, o.reason);
        ctx.out.result(m, () => ctx.out.success(`Retired ${m.id}.`));
      });
    });

  memory.command('export').description('Write memories to a file or stdout')
    .option('--format <format>', 'json or markdown', 'markdown')
    .option('--out <file>', 'file to write (default: stdout)')
    .action((o: { format: string; out?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      if (o.format !== 'json' && o.format !== 'markdown') throw new UsageError(`Unknown format "${o.format}".`, 'Use json or markdown.');
      withProject((_p, db) => {
        const rows = listMemories(db, { limit: 5000 });
        const text = o.format === 'json' ? `${JSON.stringify(rows, null, 2)}\n` : toMarkdown(rows);
        if (o.out) {
          writeFileSync(o.out, text);
          ctx.out.success(`Wrote ${rows.length} memories to ${o.out}.`);
        } else {
          process.stdout.write(text);
        }
      });
    });

  memory.command('stats').description('Counts by category and status')
    .action((_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      withProject((_p, db) => {
        const s = memoryStats(db);
        ctx.out.result(s, () => renderStats(ctx, s));
      });
    });
}
