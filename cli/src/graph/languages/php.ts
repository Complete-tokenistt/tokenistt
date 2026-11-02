/** PHP. Everything not marked private or protected counts as exported. Namespaces resolve by PSR-4 style path suffix. */
import { lineOf, type FileBuilder, type Visitor } from '../builder.js';
import type { SyntaxNode } from '../parser.js';

const lastSegment = (name: string): string => name.split('\\').pop() ?? name;

const stringContent = (n: SyntaxNode | null | undefined): string | undefined => {
  if (n?.type !== 'string' && n?.type !== 'encapsed_string') return undefined;
  return n.namedChildren.find((c) => c?.type === 'string_content')?.text;
};

function useClause(clause: SyntaxNode, line: number, b: FileBuilder): void {
  const nameNode = clause.namedChildren.find((c) => c?.type === 'qualified_name' || c?.type === 'name');
  if (!nameNode) return;
  const source = nameNode.text.replace(/^\\/, '');
  const alias = clause.namedChildren.find((c) => c?.type === 'namespace_aliasing_clause')?.namedChildren[0]?.text;
  b.extract.imports.push({ source, line, bindings: [{ imported: lastSegment(source), local: alias ?? lastSegment(source) }], style: 'phpns' });
}

function heritage(clause: SyntaxNode, kind: 'EXTENDS' | 'IMPLEMENTS', b: FileBuilder): void {
  for (const n of clause.namedChildren) if (n && (n.type === 'name' || n.type === 'qualified_name')) b.heritage(lastSegment(n.text), kind, n);
}

function isPublic(node: SyntaxNode): boolean {
  return !node.namedChildren.some((c) => c?.type === 'visibility_modifier' && c.text !== 'public');
}

export const visitPhp: Visitor = (node, b) => {
  switch (node.type) {
    case 'namespace_definition':
      b.extract.namespace = node.childForFieldName('name')?.text;
      return;
    case 'namespace_use_declaration':
      for (const clause of node.namedChildren) if (clause?.type === 'namespace_use_clause') useClause(clause, lineOf(node), b);
      return 'skip';
    case 'require_expression':
    case 'require_once_expression':
    case 'include_expression':
    case 'include_once_expression': {
      const source = stringContent(node.namedChildren[0]);
      if (source) b.extract.imports.push({ source: source.startsWith('.') ? source : `./${source}`, line: lineOf(node), bindings: [], style: 'path' });
      return 'skip';
    }
    case 'class_declaration':
    case 'interface_declaration':
    case 'trait_declaration':
    case 'enum_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const def = b.define(node.type === 'interface_declaration' ? 'interface' : 'class', name, node, true);
      b.within(def, node, (n, inner) => {
        if (n.type === 'base_clause') { heritage(n, 'EXTENDS', inner); return 'skip'; }
        if (n.type === 'class_interface_clause') { heritage(n, 'IMPLEMENTS', inner); return 'skip'; }
        return visitPhp(n, inner);
      });
      return 'skip';
    }
    case 'function_definition':
    case 'method_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const kind = node.type === 'method_declaration' ? 'method' : 'function';
      b.within(b.define(kind, name, node, isPublic(node)), node, visitPhp);
      return 'skip';
    }
    case 'function_call_expression': {
      const fn = node.childForFieldName('function');
      if (!fn) return;
      const name = lastSegment(fn.text);
      if (name === 'getenv') {
        const arg = node.childForFieldName('arguments')?.namedChildren[0]?.namedChildren[0];
        const env = stringContent(arg);
        if (env) b.env(env, node);
        return;
      }
      if (fn.type === 'name' || fn.type === 'qualified_name') b.call(name, node);
      return;
    }
    case 'member_call_expression': {
      const name = node.childForFieldName('name')?.text;
      const object = node.childForFieldName('object')?.text;
      if (name && object === '$this') b.call(name, node, 'this');
      return;
    }
    case 'scoped_call_expression': {
      const name = node.childForFieldName('name')?.text;
      const scope = node.childForFieldName('scope')?.text;
      if (!name || !scope) return;
      b.call(name, node, scope === 'self' || scope === 'static' ? 'this' : lastSegment(scope));
      return;
    }
    case 'object_creation_expression': {
      const cls = node.namedChildren.find((c) => c?.type === 'name' || c?.type === 'qualified_name');
      if (cls) b.call(lastSegment(cls.text), node);
      return;
    }
    case 'subscript_expression': {
      const base = node.namedChildren[0]?.text;
      if (base === '$_ENV' || base === '$_SERVER') {
        const name = stringContent(node.namedChildren[1]);
        if (name && base === '$_ENV') b.env(name, node);
      }
      return;
    }
    default:
      return;
  }
};
