/** Go. Capitalised names are exported, a package is a directory, and methods are qualified by their receiver type. */
import { lineOf, type FileBuilder, type Visitor } from '../builder.js';
import type { SyntaxNode } from '../parser.js';

const exported = (name: string): boolean => /^\p{Lu}/u.test(name);
const unquote = (n: SyntaxNode | null | undefined): string | undefined => (n ? n.text.replace(/^["`]|["`]$/g, '') : undefined);

function importSpec(spec: SyntaxNode, b: FileBuilder): void {
  const source = unquote(spec.childForFieldName('path'));
  if (!source) return;
  const alias = spec.childForFieldName('name')?.text;
  // A blank or dot import binds no usable package name here.
  const local = alias && alias !== '_' && alias !== '.' ? alias : alias ? undefined : source.split('/').pop();
  b.extract.imports.push({ source, line: lineOf(spec), bindings: local ? [{ imported: '*', local }] : [], style: 'go' });
}

function receiver(node: SyntaxNode): { type?: string; name?: string } {
  const param = node.childForFieldName('receiver')?.namedChildren.find((c) => c?.type === 'parameter_declaration');
  let t = param?.childForFieldName('type');
  while (t && t.type !== 'type_identifier') t = t.type === 'pointer_type' || t.type === 'generic_type' ? t.namedChildren[0] : undefined;
  return { type: t?.text, name: param?.childForFieldName('name')?.text };
}

export const visitGo: Visitor = (node, b) => {
  switch (node.type) {
    case 'import_spec':
      importSpec(node, b);
      return 'skip';
    case 'function_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      b.within(b.define('function', name, node, exported(name)), node, visitGo);
      return 'skip';
    }
    case 'method_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const r = receiver(node);
      const def = b.defineIn(r.type, 'method', name, node, exported(name));
      b.withSelf(r.name, () => b.within(def, node, visitGo));
      return 'skip';
    }
    case 'type_spec': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return 'skip';
      const shape = node.childForFieldName('type')?.type;
      const kind = shape === 'struct_type' ? 'class' : shape === 'interface_type' ? 'interface' : 'type';
      b.define(kind, name, node, exported(name));
      return 'skip';
    }
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier') b.call(fn.text, node);
      else if (fn?.type === 'selector_expression') {
        const operand = fn.childForFieldName('operand');
        const field = fn.childForFieldName('field')?.text;
        if (!field || operand?.type !== 'identifier') return;
        if (operand.text === 'os' && (field === 'Getenv' || field === 'LookupEnv')) {
          const name = unquote(node.childForFieldName('arguments')?.namedChildren[0]);
          if (name) b.env(name, node);
          return;
        }
        b.call(field, node, operand.text === b.selfName ? 'this' : operand.text);
      }
      return;
    }
    default:
      return;
  }
};
