/**
 * Table access from SQL held in code strings. Only statements that open with a SQL verb are read, and the linker
 * keeps a table only if the repository defines it, so words after FROM in ordinary text cannot invent tables.
 */
import { tokenizeSql } from '../languages/sql.js';

export interface SqlAccess {
  table: string;
  access: 'read' | 'write';
}

const STATEMENT = /^\s*(WITH|SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;

export function tablesInSql(sql: string): SqlAccess[] {
  if (!STATEMENT.test(sql)) return [];
  const t = tokenizeSql(sql);
  const out = new Map<string, 'read' | 'write'>();
  const name = (i: number): string | undefined => {
    const first = t[i];
    if (first?.kind !== 'word') return undefined;
    const full = t[i + 1]?.text === '.' && t[i + 2]?.kind === 'word' ? `${first.text}.${t[i + 2]?.text}` : first.text;
    return full.replace(/^public\./i, '').toLowerCase();
  };
  const add = (i: number, access: 'read' | 'write'): void => {
    const table = name(i);
    if (table && out.get(table) !== 'write') out.set(table, access);
  };
  for (let i = 0; i < t.length; i++) {
    const u = t[i]?.upper;
    if ((u === 'INSERT' && t[i + 1]?.upper === 'INTO') || (u === 'DELETE' && t[i + 1]?.upper === 'FROM')) add(i + 2, 'write');
    else if (u === 'UPDATE' && t[i - 1]?.upper !== 'DO' && t[i - 1]?.upper !== 'FOR' && t[i - 1]?.upper !== 'KEY') add(i + 1, 'write');
    else if (u === 'FROM' && t[i - 1]?.upper !== 'DELETE') add(i + 1, 'read');
    else if (u === 'JOIN') add(i + 1, 'read');
  }
  return [...out].map(([table, access]) => ({ table, access }));
}
