/** Spring Boot controllers and JPA entities. */
import type { SyntaxNode } from '../parser.js';
import type { FileExtract } from '../schema.js';

const MAPPINGS: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE', RequestMapping: 'ANY' };

const joinPath = (a: string, b: string): string => {
  const joined = `/${a}/${b}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
};

function annotations(node: SyntaxNode): Array<{ name: string; arg?: string; args: Record<string, string> }> {
  const modifiers = node.namedChildren.find((c) => c?.type === 'modifiers');
  const out: Array<{ name: string; arg?: string; args: Record<string, string> }> = [];
  for (const a of modifiers?.namedChildren ?? []) {
    if (a?.type !== 'annotation' && a?.type !== 'marker_annotation') continue;
    const name = a.childForFieldName('name')?.text;
    if (!name) continue;
    const args: Record<string, string> = {};
    let arg: string | undefined;
    for (const v of a.childForFieldName('arguments')?.namedChildren ?? []) {
      if (v?.type === 'string_literal') arg = v.text.slice(1, -1);
      else if (v?.type === 'element_value_pair') {
        const key = v.childForFieldName('key')?.text;
        const value = v.childForFieldName('value');
        if (key && value?.type === 'string_literal') args[key] = value.text.slice(1, -1);
      }
    }
    out.push({ name, ...(arg !== undefined ? { arg } : {}), args });
  }
  return out;
}

function springClass(node: SyntaxNode, x: FileExtract): void {
  const name = node.childForFieldName('name')?.text;
  if (!name) return;
  const anns = annotations(node);
  if (anns.some((a) => a.name === 'Entity')) {
    const t = anns.find((a) => a.name === 'Table');
    const columns: Array<{ name: string; line: number }> = [];
    for (const f of node.childForFieldName('body')?.namedChildren ?? []) {
      if (f?.type !== 'field_declaration') continue;
      const col = f.childForFieldName('declarator')?.childForFieldName('name')?.text;
      if (col) columns.push({ name: (annotations(f).find((a) => a.name === 'Column')?.args.name ?? col).toLowerCase(), line: f.startPosition.row + 1 });
    }
    x.tables.push({ name: (t?.args.name ?? name).toLowerCase(), line: node.startPosition.row + 1, endLine: node.endPosition.row + 1, columns, references: [], readsFrom: [], orm: 'jpa', model: name });
  }
  const isController = anns.some((a) => a.name === 'RestController' || a.name === 'Controller');
  const base = anns.find((a) => a.name === 'RequestMapping');
  const prefix = base?.arg ?? base?.args.value ?? base?.args.path ?? '';
  for (const m of node.childForFieldName('body')?.namedChildren ?? []) {
    if (m?.type === 'field_declaration' || m?.type === 'constructor_declaration') {
      // Injected collaborators: an @Autowired field or a constructor parameter.
      if (m.type === 'field_declaration' && annotations(m).some((a) => a.name === 'Autowired')) {
        const type = m.childForFieldName('type');
        if (type?.type === 'type_identifier') x.uses.push({ from: name, name: type.text, line: m.startPosition.row + 1 });
      }
      if (m.type === 'constructor_declaration') {
        for (const p of m.childForFieldName('parameters')?.namedChildren ?? []) {
          const type = p?.childForFieldName('type');
          if (type?.type === 'type_identifier') x.uses.push({ from: name, name: type.text, line: type.startPosition.row + 1 });
        }
      }
    }
    if (!isController || m?.type !== 'method_declaration') continue;
    const method = m.childForFieldName('name')?.text;
    if (!method) continue;
    for (const a of annotations(m)) {
      const verb = MAPPINGS[a.name];
      if (verb) x.endpoints.push({ method: verb, path: joinPath(prefix, a.arg ?? a.args.value ?? a.args.path ?? ''), framework: 'spring', line: m.startPosition.row + 1, handler: { name: `${name}.${method}`, qualified: true } });
    }
  }
}

export function analyzeJava(root: SyntaxNode, x: FileExtract): void {
  const walk = (n: SyntaxNode): void => {
    if (n.type === 'class_declaration') springClass(n, x);
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(root);
}
