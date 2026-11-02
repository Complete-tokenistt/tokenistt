/** Express-style routers, NestJS, React, Drizzle, Prisma Client, Supabase and raw SQL, for TS and JS files. */
import type { SyntaxNode } from '../parser.js';
import type { FileExtract, TableAccess } from '../schema.js';
import { tablesInSql } from './sql-in-code.js';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const ROUTER_NAME = /^(app|server|.*router|.*routes?)$/i;
const NEST_VERBS: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS', All: 'ALL' };
const DRIZZLE_TABLES = new Set(['pgTable', 'mysqlTable', 'sqliteTable']);
const DRIZZLE_READ = new Set(['from', 'leftJoin', 'rightJoin', 'innerJoin', 'fullJoin']);
const DRIZZLE_WRITE = new Set(['insert', 'update', 'delete']);
const PRISMA_READ = new Set(['findMany', 'findUnique', 'findFirst', 'findUniqueOrThrow', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']);
const PRISMA_WRITE = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
const SUPABASE_WRITE = new Set(['insert', 'update', 'delete', 'upsert']);
const QUERY_METHODS = new Set(['query', 'execute', 'raw', 'unsafe', 'run', 'prepare', 'exec', 'all', 'get']);

const stringText = (n: SyntaxNode | null | undefined): string | undefined => {
  if (!n) return undefined;
  if (n.type === 'string') return n.text.slice(1, -1);
  if (n.type === 'template_string') return n.text.slice(1, -1);
  return undefined;
};

const joinPath = (a: string, b: string): string => {
  const joined = `/${a}/${b}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
};

/** The qualified name of the symbol containing this node, from the extract's line ranges. */
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

function inlineCalls(fn: SyntaxNode): Array<{ callee: string; object?: string; line: number }> {
  const out: Array<{ callee: string; object?: string; line: number }> = [];
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'call_expression') {
      const f = n.childForFieldName('function');
      if (f?.type === 'identifier') out.push({ callee: f.text, line: n.startPosition.row + 1 });
      else if (f?.type === 'member_expression' && f.childForFieldName('object')?.type === 'identifier') {
        const callee = f.childForFieldName('property')?.text;
        const object = f.childForFieldName('object')?.text;
        if (callee && object) out.push({ callee, object, line: n.startPosition.row + 1 });
      }
    }
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(fn);
  return out;
}

function routerCall(node: SyntaxNode, x: FileExtract, usesExpress: boolean): boolean {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'member_expression') return false;
  const object = fn.childForFieldName('object');
  const method = fn.childForFieldName('property')?.text;
  if (object?.type !== 'identifier' || !method || !ROUTER_NAME.test(object.text)) return false;
  const args = (node.childForFieldName('arguments')?.namedChildren ?? []).filter((a): a is SyntaxNode => !!a);
  const line = node.startPosition.row + 1;

  if (method === 'use') {
    const prefix = args[0]?.type === 'string' ? stringText(args[0]) : undefined;
    const router = args[args.length - 1];
    if ((router?.type === 'identifier' || router?.type === 'member_expression') && (prefix === undefined || prefix.startsWith('/'))) {
      x.mounts.push({ prefix: prefix ?? '', router: router.text, on: object.text, line });
    }
    return true;
  }
  if (!VERBS.has(method) || args.length < 2) return false;
  const path = args[0]?.type === 'string' ? stringText(args[0]) : undefined;
  if (path === undefined || !path.startsWith('/')) return false;
  const last = args[args.length - 1];
  const isInline = last?.type === 'arrow_function' || last?.type === 'function_expression';
  x.endpoints.push({
    method: method.toUpperCase(), path, framework: usesExpress ? 'express' : 'http-router', line, router: object.text,
    ...(last?.type === 'identifier' ? { handler: { name: last.text } } : {}),
    ...(last?.type === 'member_expression' && last.childForFieldName('object')?.type === 'identifier'
      ? { handler: { name: last.childForFieldName('property')?.text ?? '', object: last.childForFieldName('object')?.text } }
      : {}),
    // Wrappers like endpoint('perm', async (req) => ...) and spread wrappers still hold the handler's calls.
    calls: inlineCalls(isInline && last ? last : node),
  });
  return true;
}

function decoratorInfo(d: SyntaxNode): { name: string; arg?: string } | undefined {
  const c = d.namedChildren[0];
  if (c?.type === 'identifier') return { name: c.text };
  if (c?.type === 'call_expression') {
    const name = c.childForFieldName('function')?.text;
    if (!name) return undefined;
    return { name, arg: stringText(c.childForFieldName('arguments')?.namedChildren[0]) ?? undefined };
  }
  return undefined;
}

/** NestJS: @Controller('x') on the class, @Get('y') on methods, and constructor injection. */
function nestClass(node: SyntaxNode, x: FileExtract): void {
  const name = node.childForFieldName('name')?.text;
  if (!name) return;
  const parent = node.parent;
  const own = node.namedChildren.filter((c) => c?.type === 'decorator');
  const outer = parent?.type === 'export_statement' ? parent.namedChildren.filter((c) => c?.type === 'decorator') : [];
  const controller = [...own, ...outer].map((d) => (d ? decoratorInfo(d) : undefined)).find((d) => d?.name === 'Controller');

  const body = node.childForFieldName('body');
  let pending: SyntaxNode[] = [];
  for (const m of body?.namedChildren ?? []) {
    if (!m) continue;
    if (m.type === 'decorator') { pending.push(m); continue; }
    if (m.type === 'method_definition') {
      const method = m.childForFieldName('name')?.text;
      if (method === 'constructor') {
        for (const p of m.childForFieldName('parameters')?.namedChildren ?? []) {
          const type = p?.childForFieldName('type')?.namedChildren[0];
          if (type?.type === 'type_identifier') x.uses.push({ from: name, name: type.text, line: type.startPosition.row + 1 });
        }
      } else if (controller && method) {
        const decorators = [...pending, ...m.namedChildren.filter((c) => c?.type === 'decorator')];
        for (const d of decorators) {
          const info = d ? decoratorInfo(d) : undefined;
          const verb = info && NEST_VERBS[info.name];
          if (verb) x.endpoints.push({ method: verb, path: joinPath(controller.arg ?? '', info.arg ?? ''), framework: 'nestjs', line: m.startPosition.row + 1, handler: { name: `${name}.${method}`, qualified: true } });
        }
      }
    }
    pending = [];
  }
}

function drizzleTable(node: SyntaxNode, x: FileExtract): boolean {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'identifier' || !DRIZZLE_TABLES.has(fn.text)) return false;
  const args = node.childForFieldName('arguments')?.namedChildren ?? [];
  const table = stringText(args[0]);
  if (!table) return false;
  const decl = node.parent;
  const columns: Array<{ name: string; line: number }> = [];
  for (const p of args[1]?.type === 'object' ? args[1].namedChildren : []) {
    if (p?.type !== 'pair') continue;
    // The database column name is the first argument to the column builder, when it is given.
    const value = p.childForFieldName('value');
    let call: SyntaxNode | null | undefined = value;
    while (call?.type === 'call_expression' && call.childForFieldName('function')?.type === 'member_expression') call = call.childForFieldName('function')?.childForFieldName('object');
    const dbName = call?.type === 'call_expression' ? stringText(call.childForFieldName('arguments')?.namedChildren[0]) : undefined;
    const key = p.childForFieldName('key')?.text;
    if (dbName ?? key) columns.push({ name: (dbName ?? key ?? '').toLowerCase(), line: p.startPosition.row + 1 });
  }
  x.tables.push({
    name: table.toLowerCase(), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1, columns, references: [], readsFrom: [], orm: 'drizzle',
    ...(decl?.type === 'variable_declarator' && decl.childForFieldName('name')?.type === 'identifier' ? { variable: decl.childForFieldName('name')?.text } : {}),
  });
  return true;
}

function dataAccess(node: SyntaxNode, x: FileExtract): void {
  const fn = node.childForFieldName('function');
  const from = () => enclosing(x, node);
  const line = node.startPosition.row + 1;
  const add = (a: Omit<TableAccess, 'from' | 'line'>): void => { x.tableAccess.push({ ...a, from: from(), line }); };

  if (fn?.type === 'member_expression') {
    const method = fn.childForFieldName('property')?.text ?? '';
    const object = fn.childForFieldName('object');
    const args = node.childForFieldName('arguments')?.namedChildren ?? [];

    // Drizzle: db.select().from(users), db.insert(users).
    if ((DRIZZLE_READ.has(method) || DRIZZLE_WRITE.has(method)) && args[0]?.type === 'identifier') {
      add({ variable: args[0].text, access: DRIZZLE_WRITE.has(method) ? 'write' : 'read', via: 'drizzle' });
    }
    // Prisma: prisma.user.findMany().
    const owner = object?.type === 'member_expression' ? object.childForFieldName('object') : undefined;
    const model = object?.type === 'member_expression' ? object.childForFieldName('property')?.text : undefined;
    if (owner?.type === 'identifier' && /prisma/i.test(owner.text) && model) {
      if (PRISMA_READ.has(method)) add({ model, access: 'read', via: 'prisma' });
      else if (PRISMA_WRITE.has(method)) add({ model, access: 'write', via: 'prisma' });
    }
    // Supabase: supabase.from('users').select().
    if (method === 'from' && object?.type === 'identifier' && /supabase/i.test(object.text)) {
      const table = stringText(args[0]);
      if (table) {
        const next = node.parent?.type === 'member_expression' ? node.parent.childForFieldName('property')?.text : undefined;
        add({ table: table.toLowerCase(), access: next && SUPABASE_WRITE.has(next) ? 'write' : 'read', via: 'supabase' });
      }
    }
    // Raw SQL: pool.query('SELECT ...').
    if (QUERY_METHODS.has(method)) {
      const sql = stringText(args[0]);
      if (sql) for (const a of tablesInSql(sql)) add({ table: a.table, access: a.access, via: 'sql' });
    }
  }
}

function taggedSql(node: SyntaxNode, x: FileExtract): void {
  const fn = node.childForFieldName('function');
  const tpl = node.childForFieldName('arguments');
  if (fn?.text !== 'sql' || tpl?.type !== 'template_string') return;
  for (const a of tablesInSql(tpl.text.slice(1, -1))) x.tableAccess.push({ table: a.table, access: a.access, via: 'sql', from: enclosing(x, node), line: node.startPosition.row + 1 });
}

/** React: a capitalised function or class in a JSX file that renders JSX is a component. */
function reactFacts(root: SyntaxNode, x: FileExtract): void {
  const components = new Set<string>();
  const seen = new Set<string>();
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'jsx_opening_element' || n.type === 'jsx_self_closing_element') {
      const name = n.childForFieldName('name');
      const at = enclosing(x, n);
      if (at) {
        const top = at.split('.')[0] ?? at;
        if (/^\p{Lu}/u.test(top)) components.add(top);
      }
      if (name?.type === 'identifier' && /^\p{Lu}/u.test(name.text)) {
        const key = `${at ?? ''}\0${name.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          x.uses.push({ from: at, name: name.text, line: n.startPosition.row + 1 });
        }
      }
    }
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(root);
  x.components = [...components].sort();
}

export function analyzeJavaScript(root: SyntaxNode, x: FileExtract): void {
  const usesExpress = x.imports.some((i) => i.source === 'express');
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'call_expression') {
      if (!routerCall(n, x, usesExpress) && !drizzleTable(n, x)) dataAccess(n, x);
      taggedSql(n, x);
    } else if (n.type === 'class_declaration' || n.type === 'abstract_class_declaration') {
      nestClass(n, x);
    }
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(root);
  if (/\.(tsx|jsx)$/.test(x.path)) reactFacts(root, x);
}
