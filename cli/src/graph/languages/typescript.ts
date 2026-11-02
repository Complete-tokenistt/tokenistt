/** TypeScript, TSX and JavaScript. The grammars share node names except for a few type-only forms. */
import { lineOf, type FileBuilder, type Visitor } from '../builder.js';
import type { SyntaxNode } from '../parser.js';

const stringValue = (n: SyntaxNode | null | undefined): string | undefined => {
  if (!n || n.type !== 'string') return undefined;
  return n.text.slice(1, -1);
};

function isExported(node: SyntaxNode): boolean {
  let n: SyntaxNode | null = node.parent;
  for (let i = 0; n && i < 3; i++, n = n.parent) {
    if (n.type === 'export_statement') return true;
    if (n.type !== 'lexical_declaration' && n.type !== 'variable_declaration' && n.type !== 'variable_declarator') return false;
  }
  return false;
}

function isDefaultExport(node: SyntaxNode): boolean {
  const p = node.parent;
  return p?.type === 'export_statement' && p.children.some((c) => c?.type === 'default');
}

function importStatement(node: SyntaxNode, b: FileBuilder): void {
  const source = stringValue(node.childForFieldName('source'));
  if (source === undefined) return;
  const bindings: Array<{ imported: string; local: string }> = [];
  const typeOnly = node.children.some((c) => c?.type === 'type');
  const clause = node.namedChildren.find((c) => c?.type === 'import_clause');
  for (const part of clause?.namedChildren ?? []) {
    if (!part) continue;
    if (part.type === 'identifier') bindings.push({ imported: 'default', local: part.text });
    else if (part.type === 'namespace_import') {
      const id = part.namedChildren.find((c) => c?.type === 'identifier');
      if (id) bindings.push({ imported: '*', local: id.text });
    } else if (part.type === 'named_imports') {
      for (const spec of part.namedChildren) {
        if (spec?.type !== 'import_specifier') continue;
        const name = spec.childForFieldName('name')?.text;
        if (name) bindings.push({ imported: name, local: spec.childForFieldName('alias')?.text ?? name });
      }
    }
  }
  b.extract.imports.push({ source, line: lineOf(node), bindings, style: 'path', ...(typeOnly ? { typeOnly } : {}) });
}

function exportStatement(node: SyntaxNode, b: FileBuilder): void {
  const source = stringValue(node.childForFieldName('source'));
  const clause = node.namedChildren.find((c) => c?.type === 'export_clause');
  const specs = (clause?.namedChildren ?? []).filter((c): c is SyntaxNode => c?.type === 'export_specifier');
  if (source !== undefined) {
    b.extract.reExports.push({
      source,
      names: specs.map((s) => {
        const imported = s.childForFieldName('name')?.text ?? '';
        return { imported, exported: s.childForFieldName('alias')?.text ?? imported };
      }),
    });
    b.extract.imports.push({ source, line: lineOf(node), bindings: [], style: 'path' });
    return;
  }
  for (const s of specs) {
    const name = s.childForFieldName('name')?.text;
    if (!name) continue;
    const alias = s.childForFieldName('alias')?.text;
    if (alias === 'default') b.extract.defaultExport = name;
    const def = b.extract.symbols.find((d) => d.qualified === name);
    if (def) def.exported = true;
    else b.extract.reExports.push({ source: '', names: [{ imported: name, exported: alias ?? name }] });
  }
  if (node.children.some((c) => c?.type === 'default')) {
    const value = node.childForFieldName('value');
    if (value?.type === 'identifier') b.extract.defaultExport = value.text;
  }
}

function classHeritage(node: SyntaxNode, b: FileBuilder): void {
  for (const h of node.namedChildren) {
    if (h?.type !== 'class_heritage') continue;
    for (const clause of h.namedChildren) {
      if (!clause) continue;
      if (clause.type === 'extends_clause') {
        const v = clause.childForFieldName('value');
        if (v?.type === 'identifier') b.heritage(v.text, 'EXTENDS', v);
      } else if (clause.type === 'implements_clause') {
        for (const t of clause.namedChildren) {
          const name = typeName(t);
          if (name && t) b.heritage(name, 'IMPLEMENTS', t);
        }
      } else if (clause.type === 'identifier') {
        // Plain JavaScript has no extends_clause wrapper.
        b.heritage(clause.text, 'EXTENDS', clause);
      }
    }
  }
}

function typeName(t: SyntaxNode | null): string | undefined {
  if (!t) return undefined;
  if (t.type === 'type_identifier' || t.type === 'identifier') return t.text;
  if (t.type === 'generic_type') return typeName(t.childForFieldName('name'));
  return undefined;
}

function callExpression(node: SyntaxNode, b: FileBuilder): void {
  const fn = node.childForFieldName('function') ?? node.childForFieldName('constructor');
  if (!fn) return;
  if (fn.type === 'import') {
    const source = stringValue(node.childForFieldName('arguments')?.namedChildren[0]);
    if (source !== undefined) b.extract.imports.push({ source, line: lineOf(node), bindings: [], style: 'path' });
    return;
  }
  if (fn.type === 'identifier') {
    if (fn.text === 'require') {
      const source = stringValue(node.childForFieldName('arguments')?.namedChildren[0]);
      if (source !== undefined) {
        b.extract.imports.push({ source, line: lineOf(node), bindings: requireBindings(node), style: 'path' });
        return;
      }
    }
    b.call(fn.text, node);
  } else if (fn.type === 'member_expression') {
    const object = fn.childForFieldName('object');
    const property = fn.childForFieldName('property');
    if (!property) return;
    if (object?.type === 'this') b.call(property.text, node, 'this');
    else if (object?.type === 'identifier') b.call(property.text, node, object.text);
  }
}

/** `const x = require('y')` and `const { a, b: c } = require('y')`. */
function requireBindings(call: SyntaxNode): Array<{ imported: string; local: string }> {
  const decl = call.parent;
  if (decl?.type !== 'variable_declarator') return [];
  const name = decl.childForFieldName('name');
  if (name?.type === 'identifier') return [{ imported: '*', local: name.text }];
  if (name?.type !== 'object_pattern') return [];
  const out: Array<{ imported: string; local: string }> = [];
  for (const p of name.namedChildren) {
    if (p?.type === 'shorthand_property_identifier_pattern') out.push({ imported: p.text, local: p.text });
    else if (p?.type === 'pair_pattern') {
      const key = p.childForFieldName('key')?.text;
      const value = p.childForFieldName('value')?.text;
      if (key && value) out.push({ imported: key, local: value });
    }
  }
  return out;
}

/** process.env.X, process.env['X'], import.meta.env.X. Destructuring and dynamic keys are not tracked. */
function envReference(node: SyntaxNode, b: FileBuilder): void {
  const object = node.childForFieldName('object')?.text;
  if (object !== 'process.env' && object !== 'import.meta.env') return;
  if (node.type === 'member_expression') {
    const name = node.childForFieldName('property')?.text;
    if (name) b.env(name, node);
  } else {
    const name = stringValue(node.childForFieldName('index'));
    if (name) b.env(name, node);
  }
}

/** `module.exports = { a, b }`, `module.exports = a`, `exports.a = a`. */
function commonJsExport(node: SyntaxNode, b: FileBuilder): void {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;
  const mark = (name: string): void => {
    const def = b.extract.symbols.find((d) => d.qualified === name);
    if (def) def.exported = true;
  };
  if (left.text === 'module.exports') {
    if (right.type === 'identifier') {
      mark(right.text);
      b.extract.defaultExport = right.text;
    } else if (right.type === 'object') {
      for (const p of right.namedChildren) {
        if (p?.type === 'shorthand_property_identifier') mark(p.text);
        else if (p?.type === 'pair' && p.childForFieldName('value')?.type === 'identifier') mark(p.childForFieldName('value')?.text ?? '');
      }
    }
  } else if (left.type === 'member_expression' && left.childForFieldName('object')?.text === 'exports' && right.type === 'identifier') {
    mark(right.text);
  }
}

export const visitTypeScript: Visitor = (node, b) => {
  switch (node.type) {
    case 'import_statement':
      importStatement(node, b);
      return 'skip';
    case 'export_statement':
      // Declarations under the export are visited as usual; their own handlers read the export from the parent.
      exportStatement(node, b);
      return;
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      if (isDefaultExport(node)) b.extract.defaultExport = name;
      b.within(b.define('function', name, node, isExported(node)), node, visitTypeScript);
      return 'skip';
    }
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'class': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      if (isDefaultExport(node)) b.extract.defaultExport = name;
      const def = b.define('class', name, node, isExported(node));
      b.within(def, node, (n, inner) => {
        if (n.type === 'class_heritage') {
          classHeritage(n.parent ?? n, inner);
          return 'skip';
        }
        return visitTypeScript(n, inner);
      });
      return 'skip';
    }
    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      const def = b.define('interface', name, node, isExported(node));
      b.within(def, node, (n, inner) => {
        if (n.type === 'extends_type_clause') {
          for (const t of n.namedChildren) {
            const base = typeName(t);
            if (base && t) inner.heritage(base, 'EXTENDS', t);
          }
          return 'skip';
        }
        return undefined;
      });
      return 'skip';
    }
    case 'type_alias_declaration':
    case 'enum_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name) b.define('type', name, node, isExported(node));
      return 'skip';
    }
    case 'method_definition':
    case 'abstract_method_signature': {
      const name = node.childForFieldName('name')?.text;
      if (!name) return;
      b.within(b.define('method', name, node), node, visitTypeScript);
      return 'skip';
    }
    case 'public_field_definition':
    case 'field_definition': {
      const value = node.childForFieldName('value');
      const name = (node.childForFieldName('name') ?? node.childForFieldName('property'))?.text;
      if (name && (value?.type === 'arrow_function' || value?.type === 'function_expression')) {
        b.within(b.define('method', name, node), node, visitTypeScript);
        return 'skip';
      }
      return;
    }
    case 'variable_declarator': {
      const nameNode = node.childForFieldName('name');
      const value = node.childForFieldName('value');
      if (nameNode?.type !== 'identifier') return;
      if (value?.type === 'arrow_function' || value?.type === 'function_expression' || value?.type === 'generator_function') {
        b.within(b.define('function', nameNode.text, node, isExported(node)), node, visitTypeScript);
        return 'skip';
      }
      if (!b.scope && isExported(node)) b.define('variable', nameNode.text, node, true);
      return;
    }
    case 'call_expression':
    case 'new_expression':
      callExpression(node, b);
      return;
    case 'member_expression':
    case 'subscript_expression':
      envReference(node, b);
      return;
    case 'assignment_expression':
      commonJsExport(node, b);
      return;
    default:
      return;
  }
};
