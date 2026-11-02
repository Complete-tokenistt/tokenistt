/** Python. Every top-level name without a leading underscore counts as exported, matching `import *` semantics. */
import { lineOf, type FileBuilder, type Visitor } from '../builder.js';
import type { SyntaxNode } from '../parser.js';

const stringValue = (n: SyntaxNode | null | undefined): string | undefined => {
  if (n?.type !== 'string') return undefined;
  const content = n.namedChildren.find((c) => c?.type === 'string_content');
  return content?.text;
};

const isPublic = (name: string, b: FileBuilder): boolean => !b.scope && !name.startsWith('_');

function importStatement(node: SyntaxNode, b: FileBuilder): void {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'dotted_name') {
      b.extract.imports.push({ source: c.text, line: lineOf(node), bindings: [{ imported: '*', local: c.text }], style: 'python' });
    } else if (c.type === 'aliased_import') {
      const source = c.childForFieldName('name')?.text;
      const alias = c.childForFieldName('alias')?.text;
      if (source && alias) b.extract.imports.push({ source, line: lineOf(node), bindings: [{ imported: '*', local: alias }], style: 'python' });
    }
  }
}

function importFrom(node: SyntaxNode, b: FileBuilder): void {
  const source = node.childForFieldName('module_name')?.text;
  if (!source) return;
  const bindings: Array<{ imported: string; local: string }> = [];
  for (const n of node.childrenForFieldName('name')) {
    if (!n) continue;
    if (n.type === 'dotted_name') bindings.push({ imported: n.text, local: n.text });
    else if (n.type === 'aliased_import') {
      const imported = n.childForFieldName('name')?.text;
      const local = n.childForFieldName('alias')?.text;
      if (imported && local) bindings.push({ imported, local });
    }
  }
  b.extract.imports.push({ source, line: lineOf(node), bindings, style: 'python' });
}

/** os.environ['X'], os.environ.get('X'), os.getenv('X'). */
function envSubscript(node: SyntaxNode, b: FileBuilder): void {
  if (node.childForFieldName('value')?.text !== 'os.environ') return;
  const name = stringValue(node.childForFieldName('subscript'));
  if (name) b.env(name, node);
}

function call(node: SyntaxNode, b: FileBuilder): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  if (fn.text === 'os.getenv' || fn.text === 'os.environ.get') {
    const name = stringValue(node.childForFieldName('arguments')?.namedChildren[0]);
    if (name) b.env(name, node);
    return;
  }
  if (fn.type === 'identifier') b.call(fn.text, node);
  else if (fn.type === 'attribute') {
    const object = fn.childForFieldName('object');
    const attribute = fn.childForFieldName('attribute');
    if (attribute && object?.type === 'identifier') b.call(attribute.text, node, object.text === 'self' || object.text === 'cls' ? 'this' : object.text);
  }
}

export const visitPython: Visitor = (node, b) => {
  switch (node.type) {
    case 'import_statement':
      importStatement(node, b);
      return 'skip';
    case 'import_from_statement':
      importFrom(node, b);
      return 'skip';
    case 'function_definition': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const kind = b.scope?.kind === 'class' ? 'method' : 'function';
      b.within(b.define(kind, name, node, isPublic(name, b)), node, visitPython);
      return 'skip';
    }
    case 'class_definition': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const def = b.define('class', name, node, isPublic(name, b));
      b.within(def, node, (n, inner) => {
        if (n.type === 'argument_list' && n.parent?.id === node.id) {
          for (const base of n.namedChildren) if (base?.type === 'identifier') inner.heritage(base.text, 'EXTENDS', base);
          return 'skip';
        }
        return visitPython(n, inner);
      });
      return 'skip';
    }
    case 'call':
      call(node, b);
      return;
    case 'subscript':
      envSubscript(node, b);
      return;
    default:
      return;
  }
};
