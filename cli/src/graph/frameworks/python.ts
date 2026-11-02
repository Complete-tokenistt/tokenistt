/** FastAPI, Flask and Django, plus raw SQL strings. */
import { posix } from 'node:path';
import type { SyntaxNode } from '../parser.js';
import type { FileExtract } from '../schema.js';
import { tablesInSql } from './sql-in-code.js';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const DJANGO_READ = new Set(['all', 'filter', 'get', 'exclude', 'first', 'last', 'count', 'exists', 'values', 'values_list', 'annotate', 'aggregate', 'order_by']);
const DJANGO_WRITE = new Set(['create', 'bulk_create', 'update', 'update_or_create', 'get_or_create', 'delete', 'bulk_update']);
const QUERY_METHODS = new Set(['execute', 'executemany', 'fetch', 'fetchrow', 'fetchval', 'raw', 'text']);

const stringText = (n: SyntaxNode | null | undefined): string | undefined => {
  if (n?.type !== 'string') return undefined;
  return n.namedChildren.filter((c) => c?.type === 'string_content').map((c) => c?.text ?? '').join('');
};

const kwarg = (args: SyntaxNode | null | undefined, name: string): SyntaxNode | undefined => {
  for (const a of args?.namedChildren ?? []) {
    if (a?.type === 'keyword_argument' && a.childForFieldName('name')?.text === name) return a.childForFieldName('value') ?? undefined;
  }
  return undefined;
};

const joinPath = (a: string, b: string): string => {
  const joined = `/${a}/${b}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
};

function decorated(node: SyntaxNode, x: FileExtract): void {
  const def = node.childForFieldName('definition');
  if (def?.type !== 'function_definition') return;
  const name = def.childForFieldName('name')?.text;
  if (!name) return;
  const owner = x.symbols.find((s) => s.name === name && s.startLine === def.startPosition.row + 1);
  const line = def.startPosition.row + 1;
  for (const d of node.namedChildren) {
    if (d?.type !== 'decorator') continue;
    const call = d.namedChildren[0];
    if (call?.type !== 'call') continue;
    const fn = call.childForFieldName('function');
    if (fn?.type !== 'attribute') continue;
    const object = fn.childForFieldName('object')?.text;
    const attr = fn.childForFieldName('attribute')?.text;
    const args = call.childForFieldName('arguments');
    const path = stringText(args?.namedChildren[0]);
    if (!object || !attr || path === undefined) continue;
    const handler = { name: owner?.qualified ?? name, qualified: true };
    if (VERBS.has(attr)) {
      x.endpoints.push({ method: attr.toUpperCase(), path, framework: x.imports.some((i) => i.source.startsWith('flask')) ? 'flask' : 'fastapi', line, router: object, handler });
    } else if (attr === 'route') {
      const methods = kwarg(args, 'methods')?.namedChildren.map((m) => stringText(m)?.toUpperCase()).filter((m): m is string => !!m) ?? ['GET'];
      for (const method of methods) x.endpoints.push({ method, path, framework: 'flask', line, router: object, handler });
    }
  }
}

function djangoModel(node: SyntaxNode, x: FileExtract): void {
  const name = node.childForFieldName('name')?.text;
  const bases = node.childForFieldName('superclasses')?.namedChildren.map((b) => b?.text ?? '') ?? [];
  if (!name || !bases.some((b) => b === 'models.Model' || b === 'Model')) return;
  let table: string | undefined;
  const columns: Array<{ name: string; line: number }> = [];
  for (const stmt of node.childForFieldName('body')?.namedChildren ?? []) {
    if (stmt?.type === 'class_definition' && stmt.childForFieldName('name')?.text === 'Meta') {
      for (const inner of stmt.childForFieldName('body')?.namedChildren ?? []) {
        const assign = inner?.namedChildren[0];
        if (assign?.type === 'assignment' && assign.childForFieldName('left')?.text === 'db_table') table = stringText(assign.childForFieldName('right'));
      }
    } else if (stmt?.type === 'expression_statement') {
      const assign = stmt.namedChildren[0];
      if (assign?.type === 'assignment' && assign.childForFieldName('right')?.type === 'call') {
        const col = assign.childForFieldName('left')?.text;
        const field = assign.childForFieldName('right')?.childForFieldName('function')?.text ?? '';
        if (col && /Field$|ForeignKey$/.test(field)) columns.push({ name: col.toLowerCase(), line: stmt.startPosition.row + 1 });
      }
    }
  }
  // Django's default is <app>_<model>, where the app is the directory holding models.py.
  const app = posix.basename(posix.dirname(x.path));
  x.tables.push({ name: (table ?? `${app}_${name}`).toLowerCase(), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1, columns, references: [], readsFrom: [], orm: 'django', model: name });
}

function enclosing(x: FileExtract, node: SyntaxNode): string | undefined {
  const line = node.startPosition.row + 1;
  let best: { q: string; size: number } | undefined;
  for (const s of x.symbols) {
    if ((s.kind === 'function' || s.kind === 'method') && s.startLine <= line && line <= s.endLine) {
      const size = s.endLine - s.startLine;
      if (!best || size <= best.size) best = { q: s.qualified, size };
    }
  }
  return best?.q;
}

function call(node: SyntaxNode, x: FileExtract): void {
  const fn = node.childForFieldName('function');
  const line = node.startPosition.row + 1;
  const args = node.childForFieldName('arguments');
  if (fn?.type === 'identifier') {
    // Django urls.py: path('users/', views.list).
    if ((fn.text === 'path' || fn.text === 're_path') && posix.basename(x.path) === 'urls.py') {
      const route = stringText(args?.namedChildren[0]);
      const target = args?.namedChildren[1];
      if (route === undefined || !target || target.type === 'call') return;
      const handler = target.type === 'attribute'
        ? { name: target.childForFieldName('attribute')?.text ?? '', object: target.childForFieldName('object')?.text }
        : target.type === 'identifier' ? { name: target.text } : undefined;
      x.endpoints.push({ method: 'ANY', path: joinPath('', route), framework: 'django', line, ...(handler ? { handler } : {}) });
    }
    return;
  }
  if (fn?.type !== 'attribute') return;
  const attr = fn.childForFieldName('attribute')?.text ?? '';
  const object = fn.childForFieldName('object');
  // FastAPI: app.include_router(router, prefix='/x').
  if (attr === 'include_router') {
    const router = args?.namedChildren[0];
    if (object?.type === 'identifier' && (router?.type === 'identifier' || router?.type === 'attribute')) {
      x.mounts.push({ prefix: stringText(kwarg(args, 'prefix')) ?? '', router: router.text, on: object.text, line });
    }
    return;
  }
  // Django ORM: User.objects.filter(...).
  if (object?.type === 'attribute' && object.childForFieldName('attribute')?.text === 'objects') {
    const model = object.childForFieldName('object')?.text;
    if (model && DJANGO_READ.has(attr)) x.tableAccess.push({ model, access: 'read', via: 'django', from: enclosing(x, node), line });
    else if (model && DJANGO_WRITE.has(attr)) x.tableAccess.push({ model, access: 'write', via: 'django', from: enclosing(x, node), line });
    return;
  }
  if (QUERY_METHODS.has(attr)) {
    const sql = stringText(args?.namedChildren[0]);
    if (sql) for (const a of tablesInSql(sql)) x.tableAccess.push({ table: a.table, access: a.access, via: 'sql', from: enclosing(x, node), line });
  }
}

/** router = APIRouter(prefix='/x') applies to every route on that router. */
function routerPrefix(node: SyntaxNode, x: FileExtract): void {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (left?.type !== 'identifier' || right?.type !== 'call' || right.childForFieldName('function')?.text !== 'APIRouter') return;
  const prefix = stringText(kwarg(right.childForFieldName('arguments'), 'prefix'));
  if (prefix) x.routerPrefixes.push({ router: left.text, prefix });
}

export function analyzePython(root: SyntaxNode, x: FileExtract): void {
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'decorated_definition') decorated(n, x);
    else if (n.type === 'class_definition') djangoModel(n, x);
    else if (n.type === 'call') call(n, x);
    else if (n.type === 'assignment') routerPrefix(n, x);
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(root);
}
