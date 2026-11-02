/**
 * SQL DDL scanner: a tokenizer plus a small state machine, not a full parser (no prebuilt wasm grammar exists).
 * It understands CREATE TABLE, CREATE VIEW and ALTER TABLE in the PostgreSQL dialect and ignores everything else.
 */
import type { AlteredTable, FileExtract, TableDef } from '../schema.js';

interface Token {
  text: string;
  upper: string;
  line: number;
  kind: 'word' | 'punct';
}

export function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const push = (text: string, kind: Token['kind']) => tokens.push({ text, upper: text.toUpperCase(), line, kind });
  while (i < sql.length) {
    const c = sql[i] ?? '';
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { if (sql[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === '\n') line++;
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") break;
        i++;
      }
      i++;
      push("''", 'punct');
      continue;
    }
    if (c === '$') {
      // Dollar-quoted bodies (functions, DO blocks) are opaque.
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? sql.length : end + m[0].length;
        for (let j = i; j < stop; j++) if (sql[j] === '\n') line++;
        i = stop;
        push("''", 'punct');
        continue;
      }
    }
    if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end;
      push(sql.slice(i + 1, stop), 'word');
      i = stop + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i, i + 256));
    if (word) { push(word[0], 'word'); i += word[0].length; continue; }
    push(c, 'punct');
    i++;
  }
  return tokens;
}

/** Column-position words that start a table constraint rather than a column. */
const CONSTRAINT_WORDS = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'EXCLUDE', 'LIKE', 'PERIOD']);
const NOT_TABLE_AFTER_FROM = new Set(['SELECT', 'LATERAL', 'UNNEST', 'GENERATE_SERIES', 'VALUES']);

class Cursor {
  i = 0;
  constructor(readonly t: Token[]) {}
  peek(offset = 0): Token | undefined { return this.t[this.i + offset]; }
  isWord(u: string, offset = 0): boolean { return this.peek(offset)?.upper === u; }
  eat(u: string): boolean {
    if (this.isWord(u)) { this.i++; return true; }
    return false;
  }
  /** schema.name, returned without the `public.` prefix so migrations that vary on it still match. */
  qualifiedName(): string | undefined {
    const first = this.peek();
    if (first?.kind !== 'word') return undefined;
    this.i++;
    let name = first.text;
    if (this.peek()?.text === '.' && this.peek(1)?.kind === 'word') {
      name = `${name}.${this.peek(1)?.text}`;
      this.i += 2;
    }
    return name.replace(/^public\./i, '').toLowerCase();
  }
}

function readReference(c: Cursor): { table: string; column?: string; line: number } | undefined {
  const line = c.peek()?.line ?? 0;
  const table = c.qualifiedName();
  if (!table) return undefined;
  let column: string | undefined;
  if (c.peek()?.text === '(' && c.peek(1)?.kind === 'word' && c.peek(2)?.text === ')') column = c.peek(1)?.text.toLowerCase();
  return { table, ...(column ? { column } : {}), line };
}

function createTable(c: Cursor): TableDef | undefined {
  const line = c.peek()?.line ?? 0;
  if (c.eat('IF')) { c.eat('NOT'); c.eat('EXISTS'); }
  const name = c.qualifiedName();
  if (!name) return undefined;
  const def: TableDef = { name, line, endLine: line, columns: [], references: [], readsFrom: [] };
  if (c.isWord('PARTITION') && c.isWord('OF', 1)) {
    c.i += 2;
    const parent = readReference(c);
    if (parent) def.references.push(parent);
  }
  if (c.peek()?.text !== '(') return def;
  c.i++;
  let depth = 1;
  let atItemStart = true;
  while (depth > 0 && c.peek()) {
    const t = c.peek() as Token;
    if (t.text === '(') depth++;
    else if (t.text === ')') depth--;
    else if (t.text === ',' && depth === 1) { atItemStart = true; c.i++; continue; }
    else if (t.upper === 'REFERENCES') {
      c.i++;
      const ref = readReference(c);
      if (ref) def.references.push(ref);
      atItemStart = false;
      continue;
    } else if (atItemStart && depth === 1 && t.kind === 'word') {
      if (!CONSTRAINT_WORDS.has(t.upper)) def.columns.push({ name: t.text.toLowerCase(), line: t.line });
      atItemStart = false;
    }
    def.endLine = t.line;
    c.i++;
  }
  return def;
}

function createView(c: Cursor): TableDef | undefined {
  const line = c.peek()?.line ?? 0;
  if (c.eat('IF')) { c.eat('NOT'); c.eat('EXISTS'); }
  const name = c.qualifiedName();
  if (!name) return undefined;
  const def: TableDef = { name, line, endLine: line, view: true, columns: [], references: [], readsFrom: [] };
  const reads = new Set<string>();
  while (c.peek() && c.peek()?.text !== ';') {
    const t = c.peek() as Token;
    if ((t.upper === 'FROM' || t.upper === 'JOIN') && c.peek(1)?.kind === 'word' && !NOT_TABLE_AFTER_FROM.has(c.peek(1)?.upper ?? '')) {
      c.i++;
      const table = c.qualifiedName();
      if (table) reads.add(table);
      continue;
    }
    def.endLine = t.line;
    c.i++;
  }
  def.readsFrom = [...reads];
  return def;
}

function alterTable(c: Cursor): AlteredTable | undefined {
  const line = c.peek()?.line ?? 0;
  if (c.eat('IF')) c.eat('EXISTS');
  c.eat('ONLY');
  const name = c.qualifiedName();
  if (!name) return undefined;
  const out: AlteredTable = { name, line, columns: [], references: [] };
  while (c.peek() && c.peek()?.text !== ';') {
    const t = c.peek() as Token;
    if (t.upper === 'ADD') {
      c.i++;
      c.eat('COLUMN');
      if (c.eat('IF')) { c.eat('NOT'); c.eat('EXISTS'); }
      const col = c.peek();
      if (col?.kind === 'word' && !CONSTRAINT_WORDS.has(col.upper)) out.columns.push({ name: col.text.toLowerCase(), line: col.line });
      continue;
    }
    if (t.upper === 'REFERENCES') {
      c.i++;
      const ref = readReference(c);
      if (ref) out.references.push(ref);
      continue;
    }
    c.i++;
  }
  return out;
}

export function extractSql(sql: string, x: FileExtract): void {
  const c = new Cursor(tokenizeSql(sql));
  while (c.peek()) {
    if (c.isWord('CREATE')) {
      c.i++;
      c.eat('OR');
      c.eat('REPLACE');
      c.eat('GLOBAL');
      c.eat('LOCAL');
      c.eat('TEMP');
      c.eat('TEMPORARY');
      c.eat('UNLOGGED');
      c.eat('MATERIALIZED');
      c.eat('RECURSIVE');
      if (c.eat('TABLE')) {
        const t = createTable(c);
        if (t) x.tables.push(t);
      } else if (c.eat('VIEW')) {
        const v = createView(c);
        if (v) x.tables.push(v);
      }
      continue;
    }
    if (c.isWord('ALTER') && c.isWord('TABLE', 1)) {
      c.i += 2;
      const a = alterTable(c);
      if (a) x.altered.push(a);
      continue;
    }
    c.i++;
  }
}
