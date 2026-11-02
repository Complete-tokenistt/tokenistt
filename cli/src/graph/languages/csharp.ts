/** C#. Namespaces span files, so `using` opens a scope in the linker rather than pointing at one file. */
import { lineOf, type FileBuilder, type Visitor } from '../builder.js';
import type { SyntaxNode } from '../parser.js';

const isPublic = (node: SyntaxNode): boolean => node.namedChildren.some((c) => c?.type === 'modifier' && (c.text === 'public' || c.text === 'internal'));
const stringValue = (n: SyntaxNode | null | undefined): string | undefined => (n?.type === 'string_literal' ? n.text.slice(1, -1) : undefined);

function baseName(t: SyntaxNode | null | undefined): string | undefined {
  if (!t) return undefined;
  if (t.type === 'identifier') return t.text;
  if (t.type === 'generic_name') return t.namedChildren[0]?.text;
  if (t.type === 'qualified_name') return baseName(t.namedChildren[t.namedChildCount - 1]);
  return undefined;
}

/** The C# syntax does not separate a base class from interfaces; the `I` prefix convention is the only hint. */
function bases(list: SyntaxNode, b: FileBuilder): void {
  for (const t of list.namedChildren) {
    const name = baseName(t);
    if (name && t) b.heritage(name, /^I\p{Lu}/u.test(name) ? 'IMPLEMENTS' : 'EXTENDS', t);
  }
}

export const visitCsharp: Visitor = (node, b) => {
  switch (node.type) {
    case 'using_directive': {
      const name = node.namedChildren.find((c) => c?.type === 'qualified_name' || c?.type === 'identifier')?.text;
      if (name) b.extract.imports.push({ source: name, line: lineOf(node), bindings: [], style: 'namespace' });
      return 'skip';
    }
    case 'namespace_declaration':
    case 'file_scoped_namespace_declaration':
      b.extract.namespace = node.childForFieldName('name')?.text;
      return;
    case 'class_declaration':
    case 'struct_declaration':
    case 'record_declaration':
    case 'enum_declaration':
    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const def = b.define(node.type === 'interface_declaration' ? 'interface' : 'class', name, node, isPublic(node));
      b.within(def, node, (n, inner) => {
        if (n.type === 'base_list') { bases(n, inner); return 'skip'; }
        return visitCsharp(n, inner);
      });
      return 'skip';
    }
    case 'method_declaration':
    case 'constructor_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      b.within(b.define('method', name, node, isPublic(node)), node, visitCsharp);
      return 'skip';
    }
    case 'invocation_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier') b.call(fn.text, node);
      else if (fn?.type === 'member_access_expression') {
        const object = fn.childForFieldName('expression');
        const name = fn.childForFieldName('name')?.text;
        if (!name || !object) return;
        if (object.text === 'Environment' && name === 'GetEnvironmentVariable') {
          const env = stringValue(node.childForFieldName('arguments')?.namedChildren[0]?.namedChildren[0]);
          if (env) b.env(env, node);
          return;
        }
        if (object.type === 'this_expression') b.call(name, node, 'this');
        else if (object.type === 'identifier') b.call(name, node, object.text);
      }
      return;
    }
    case 'object_creation_expression': {
      const name = baseName(node.childForFieldName('type'));
      if (name) b.call(name, node);
      return;
    }
    default:
      return;
  }
};
