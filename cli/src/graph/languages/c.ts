/** C and C++. Macros are not expanded, so symbols produced by them are not seen. `static` means not exported. */
import { lineOf, type FileBuilder, type Visitor } from '../builder.js';
import type { SyntaxNode } from '../parser.js';

const isStatic = (node: SyntaxNode): boolean => node.namedChildren.some((c) => c?.type === 'storage_class_specifier' && c.text === 'static');

/** Unwraps pointers and references down to the function_declarator, if this declares a function at all. */
function functionDeclarator(node: SyntaxNode | null | undefined): SyntaxNode | undefined {
  let d = node;
  for (let i = 0; d && i < 8; i++) {
    if (d.type === 'function_declarator') return d;
    d = d.childForFieldName('declarator');
  }
  return undefined;
}

function defineFunction(node: SyntaxNode, b: FileBuilder, visit: Visitor, withBody: boolean): 'skip' | void {
  const fn = functionDeclarator(node.childForFieldName('declarator'));
  const target = fn?.childForFieldName('declarator');
  if (!target) return;
  if (target.type === 'qualified_identifier') {
    const scope = target.childForFieldName('scope')?.text;
    const name = target.childForFieldName('name')?.text;
    if (!name) return;
    const def = b.defineIn(scope, 'method', name, node, true);
    if (withBody) b.within(def, node, visit);
    return 'skip';
  }
  if (target.type !== 'identifier' && target.type !== 'field_identifier' && target.type !== 'destructor_name' && target.type !== 'operator_name') return;
  const def = b.define(b.scope?.kind === 'class' ? 'method' : 'function', target.text, node, !isStatic(node));
  if (withBody) b.within(def, node, visit);
  return 'skip';
}

function classLike(node: SyntaxNode, b: FileBuilder, visit: Visitor): 'skip' | void {
  const name = node.childForFieldName('name')?.text;
  // Only a definition counts; `struct P *p` mentions a type without defining it.
  if (!name || !node.childForFieldName('body')) return;
  const def = b.define('class', name, node, true);
  b.within(def, node, (n, inner) => {
    if (n.type === 'base_class_clause') {
      for (const t of n.namedChildren) {
        if (t?.type === 'access_specifier') continue;
        const base = t?.type === 'template_type' ? t.childForFieldName('name')?.text : t?.text;
        if (base && t) inner.heritage(base.split('::').pop() ?? base, 'EXTENDS', t);
      }
      return 'skip';
    }
    return visit(n, inner);
  });
  return 'skip';
}

export const visitC: Visitor = (node, b) => {
  switch (node.type) {
    case 'preproc_include': {
      const path = node.childForFieldName('path');
      if (!path) return 'skip';
      if (path.type === 'system_lib_string') b.extract.imports.push({ source: path.text.slice(1, -1), line: lineOf(node), bindings: [], style: 'include', system: true });
      else {
        const source = path.namedChildren.find((c) => c?.type === 'string_content')?.text;
        if (source) b.extract.imports.push({ source, line: lineOf(node), bindings: [], style: 'include' });
      }
      return 'skip';
    }
    case 'function_definition':
      return defineFunction(node, b, visitC, true);
    case 'declaration':
    case 'field_declaration':
      return defineFunction(node, b, visitC, false);
    case 'struct_specifier':
    case 'class_specifier':
    case 'union_specifier':
      return classLike(node, b, visitC);
    case 'enum_specifier': {
      const name = node.childForFieldName('name')?.text;
      if (name && node.childForFieldName('body')) b.define('type', name, node, true);
      return 'skip';
    }
    case 'type_definition': {
      const name = node.childForFieldName('declarator')?.text;
      if (name && /^\w+$/.test(name)) b.define('type', name, node, true);
      return;
    }
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (!fn) return;
      if (fn.type === 'identifier') {
        if (fn.text === 'getenv') {
          const env = node.childForFieldName('arguments')?.namedChildren[0]?.namedChildren.find((c) => c?.type === 'string_content')?.text;
          if (env) b.env(env, node);
          return;
        }
        b.call(fn.text, node);
      } else if (fn.type === 'qualified_identifier') {
        const name = fn.childForFieldName('name')?.text;
        const scope = fn.childForFieldName('scope')?.text;
        if (name === 'getenv') {
          const env = node.childForFieldName('arguments')?.namedChildren[0]?.namedChildren.find((c) => c?.type === 'string_content')?.text;
          if (env) b.env(env, node);
          return;
        }
        if (name) b.call(name, node, scope);
      } else if (fn.type === 'field_expression') {
        const arg = fn.childForFieldName('argument');
        const field = fn.childForFieldName('field')?.text;
        if (field && arg?.type === 'this') b.call(field, node, 'this');
        else if (field && arg?.type === 'identifier') b.call(field, node, arg.text);
      }
      return;
    }
    default:
      return;
  }
};
