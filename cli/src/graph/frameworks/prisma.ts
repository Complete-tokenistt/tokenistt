/** Prisma schema files. A line scan of `model` blocks: there is no wasm grammar, and the format is regular. */
import type { FileExtract, TableDef } from '../schema.js';

const SCALARS = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes']);

export function extractPrisma(text: string, x: FileExtract): void {
  const lines = text.split('\n');
  let current: TableDef | undefined;
  const pendingRefs: Array<{ table: TableDef; model: string; line: number }> = [];
  const byModel = new Map<string, TableDef>();

  lines.forEach((raw, i) => {
    const line = raw.trim();
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = { name: (open[1] ?? '').toLowerCase(), line: i + 1, endLine: i + 1, columns: [], references: [], readsFrom: [], orm: 'prisma', model: open[1] };
      x.tables.push(current);
      byModel.set(open[1] ?? '', current);
      return;
    }
    if (!current) return;
    if (line === '}') {
      current.endLine = i + 1;
      current = undefined;
      return;
    }
    const map = /^@@map\(\s*"([^"]+)"\s*\)/.exec(line);
    if (map) {
      current.name = (map[1] ?? current.name).toLowerCase();
      return;
    }
    const field = /^(\w+)\s+(\w+)(\[\]|\?)?(.*)$/.exec(line);
    if (!field || line.startsWith('//') || line.startsWith('@@')) return;
    const type = field[2] ?? '';
    if (SCALARS.has(type)) {
      const column = /@map\(\s*"([^"]+)"\s*\)/.exec(field[4] ?? '')?.[1] ?? field[1] ?? '';
      current.columns.push({ name: column.toLowerCase(), line: i + 1 });
    } else if (/@relation/.test(field[4] ?? '')) {
      // Only the side holding the foreign key has @relation(fields: ...).
      pendingRefs.push({ table: current, model: type, line: i + 1 });
    }
  });
  for (const r of pendingRefs) {
    const target = byModel.get(r.model);
    if (target) r.table.references.push({ table: target.name, line: r.line });
  }
}
