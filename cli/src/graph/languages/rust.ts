/** Rust. `pub` means exported, structs and enums are classes, traits are interfaces, impl blocks qualify methods. */
import { lineOf, type FileBuilder, type Visitor } from '../builder.js';
import type { SyntaxNode } from '../parser.js';

const isPub = (node: SyntaxNode): boolean => node.namedChildren.some((c) => c?.type === 'visibility_modifier');
const unquote = (n: SyntaxNode | null | undefined): string | undefined => (n?.type === 'string_literal' ? n.text.slice(1, -1) : undefined);

function typeName(t: SyntaxNode | null | undefined): string | undefined {
  if (!t) return undefined;
  if (t.type === 'type_identifier') return t.text;
  if (t.type === 'generic_type') return typeName(t.childForFieldName('type'));
  if (t.type === 'scoped_type_identifier') return t.childForFieldName('name')?.text;
  return undefined;
}

/** Flattens a use tree into one import per leaf: `use a::{b, c as d}` becomes a::b and a::c. */
function useTree(node: SyntaxNode | null | undefined, prefix: string, line: number, b: FileBuilder): void {
  if (!node) return;
  const push = (path: string, local: string | undefined): void => {
    const leaf = path.split('::').pop() ?? path;
    b.extract.imports.push({ source: path, line, bindings: local ? [{ imported: leaf, local }] : [], style: 'rust' });
  };
  const join = (s: string): string => (prefix ? `${prefix}::${s}` : s);
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'super':
    case 'self':
    case 'scoped_identifier': {
      const path = join(node.text);
      push(path, path.split('::').pop());
      return;
    }
    case 'use_as_clause': {
      const path = node.childForFieldName('path')?.text;
      const alias = node.childForFieldName('alias')?.text;
      if (path) push(join(path), alias);
      return;
    }
    case 'scoped_use_list': {
      const path = node.childForFieldName('path')?.text ?? '';
      useTree(node.childForFieldName('list'), join(path), line, b);
      return;
    }
    case 'use_list':
      for (const child of node.namedChildren) useTree(child, prefix, line, b);
      return;
    case 'use_wildcard': {
      const path = node.namedChildren[0]?.text;
      if (path) b.extract.imports.push({ source: join(path), line, bindings: [], style: 'rust', wildcard: true });
      return;
    }
    default:
      return;
  }
}

function envCall(node: SyntaxNode, path: string, b: FileBuilder): boolean {
  if (path !== 'env::var' && path !== 'std::env::var' && path !== 'env::var_os' && path !== 'std::env::var_os') return false;
  const name = unquote(node.childForFieldName('arguments')?.namedChildren[0]);
  if (name) b.env(name, node);
  return true;
}

export const visitRust: Visitor = (node, b) => {
  switch (node.type) {
    case 'use_declaration':
      useTree(node.childForFieldName('argument'), '', lineOf(node), b);
      return 'skip';
    case 'mod_item': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return 'skip';
      // `mod x;` points at a file. An inline `mod x { }` is walked for its contents instead.
      if (!node.childForFieldName('body')) {
        b.extract.imports.push({ source: `self::${name}`, line: lineOf(node), bindings: [{ imported: '*', local: name }], style: 'rust' });
        return 'skip';
      }
      return;
    }
    case 'function_item':
    case 'function_signature_item': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const kind = b.scope?.kind === 'class' || b.scope?.kind === 'interface' ? 'method' : 'function';
      b.within(b.define(kind, name, node, isPub(node)), node, visitRust);
      return 'skip';
    }
    case 'struct_item':
    case 'enum_item':
    case 'union_item': {
      const name = node.childForFieldName('name')?.text;
      if (name) b.define('class', name, node, isPub(node));
      return 'skip';
    }
    case 'trait_item': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      b.within(b.define('interface', name, node, isPub(node)), node, visitRust);
      return 'skip';
    }
    case 'type_item': {
      const name = node.childForFieldName('name')?.text;
      if (name) b.define('type', name, node, isPub(node));
      return 'skip';
    }
    case 'impl_item': {
      const name = typeName(node.childForFieldName('type'));
      if (!name) return;
      const def = b.define('class', name, node);
      b.within(def, node, (n, inner) => {
        if (n.parent?.id === node.id && n.type !== 'declaration_list') return 'skip';
        return visitRust(n, inner);
      });
      const trait = typeName(node.childForFieldName('trait'));
      if (trait) b.extract.heritage.push({ from: def.qualified, name: trait, kind: 'IMPLEMENTS', line: lineOf(node) });
      return 'skip';
    }
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier') b.call(fn.text, node);
      else if (fn?.type === 'scoped_identifier') {
        if (envCall(node, fn.text, b)) return;
        const name = fn.childForFieldName('name')?.text;
        const path = fn.childForFieldName('path');
        if (name && path) b.call(name, node, path.text === 'Self' ? 'this' : path.text.split('::').pop());
      } else if (fn?.type === 'field_expression') {
        const value = fn.childForFieldName('value');
        const field = fn.childForFieldName('field')?.text;
        if (field && value?.type === 'self') b.call(field, node, 'this');
        else if (field && value?.type === 'identifier') b.call(field, node, value.text);
      }
      return;
    }
    case 'macro_invocation': {
      if (node.childForFieldName('macro')?.text === 'env' || node.childForFieldName('macro')?.text === 'option_env') {
        const name = unquote(node.namedChildren.find((c) => c?.type === 'token_tree')?.namedChildren[0]);
        if (name) b.env(name, node);
      }
      return;
    }
    default:
      return;
  }
};
