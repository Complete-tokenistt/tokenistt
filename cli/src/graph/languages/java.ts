/** Java. Public types and members count as exported; same-package names resolve through the linker's open scope. */
import { lineOf, type FileBuilder, type Visitor } from '../builder.js';
import type { SyntaxNode } from '../parser.js';

const isPublic = (node: SyntaxNode): boolean => node.namedChildren.some((c) => c?.type === 'modifiers' && /\bpublic\b/.test(c.text));

function typeName(t: SyntaxNode | null | undefined): string | undefined {
  if (!t) return undefined;
  if (t.type === 'type_identifier') return t.text;
  if (t.type === 'generic_type') return typeName(t.namedChildren[0]);
  if (t.type === 'scoped_type_identifier') return t.childForFieldName('name')?.text ?? t.namedChildren[t.namedChildCount - 1]?.text;
  return undefined;
}

function typeList(node: SyntaxNode | null | undefined, kind: 'EXTENDS' | 'IMPLEMENTS', b: FileBuilder): void {
  for (const child of node?.namedChildren ?? []) {
    if (child?.type === 'type_list') typeList(child, kind, b);
    else {
      const name = typeName(child);
      if (name && child) b.heritage(name, kind, child);
    }
  }
}

function importDeclaration(node: SyntaxNode, b: FileBuilder): void {
  const path = node.namedChildren.find((c) => c?.type === 'scoped_identifier' || c?.type === 'identifier')?.text;
  if (!path) return;
  if (node.namedChildren.some((c) => c?.type === 'asterisk')) {
    b.extract.imports.push({ source: path, line: lineOf(node), bindings: [], style: 'dotted', wildcard: true });
    return;
  }
  const local = path.split('.').pop() ?? path;
  b.extract.imports.push({ source: path, line: lineOf(node), bindings: [{ imported: local, local }], style: 'dotted' });
}

export const visitJava: Visitor = (node, b) => {
  switch (node.type) {
    case 'package_declaration':
      b.extract.namespace = node.namedChildren[0]?.text;
      return 'skip';
    case 'import_declaration':
      importDeclaration(node, b);
      return 'skip';
    case 'class_declaration':
    case 'record_declaration':
    case 'enum_declaration':
    case 'interface_declaration':
    case 'annotation_type_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const kind = node.type === 'interface_declaration' || node.type === 'annotation_type_declaration' ? 'interface' : 'class';
      const def = b.define(kind, name, node, isPublic(node));
      b.within(def, node, (n, inner) => {
        if (n.type === 'superclass') { typeList(n, 'EXTENDS', inner); return 'skip'; }
        if (n.type === 'super_interfaces') { typeList(n, 'IMPLEMENTS', inner); return 'skip'; }
        if (n.type === 'extends_interfaces') { typeList(n, 'EXTENDS', inner); return 'skip'; }
        return visitJava(n, inner);
      });
      return 'skip';
    }
    case 'method_declaration':
    case 'constructor_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      b.within(b.define('method', name, node, isPublic(node)), node, visitJava);
      return 'skip';
    }
    case 'method_invocation': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const object = node.childForFieldName('object');
      if (object?.text === 'System' && name === 'getenv') {
        const arg = node.childForFieldName('arguments')?.namedChildren[0];
        const env = arg?.type === 'string_literal' ? arg.namedChildren[0]?.text : undefined;
        if (env) b.env(env, node);
        return;
      }
      if (!object) b.call(name, node);
      else if (object.type === 'this') b.call(name, node, 'this');
      else if (object.type === 'identifier') b.call(name, node, object.text);
      return;
    }
    case 'object_creation_expression': {
      const name = typeName(node.childForFieldName('type'));
      if (name) b.call(name, node);
      return;
    }
    default:
      return;
  }
};
