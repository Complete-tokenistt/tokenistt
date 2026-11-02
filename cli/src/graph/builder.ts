/** Walks a syntax tree and collects a FileExtract. Language files decide what each node means; this owns scope. */
import type { CallRef, FileExtract, SymbolDef, SymbolKind } from './schema.js';
import type { SyntaxNode } from './parser.js';

const MAX_DEPTH = 1500;
const line = (n: SyntaxNode): number => n.startPosition.row + 1;

export class FileBuilder {
  private scopes: SymbolDef[] = [];

  constructor(readonly extract: FileExtract) {}

  get scope(): SymbolDef | undefined {
    return this.scopes[this.scopes.length - 1];
  }

  /** The nearest enclosing class-like scope. */
  get enclosingClass(): SymbolDef | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i];
      if (s && (s.kind === 'class' || s.kind === 'interface')) return s;
    }
    return undefined;
  }

  /** Records a symbol. Redeclarations (overloads, conditional definitions) keep the first and widen nothing. */
  define(kind: SymbolKind, name: string, node: SyntaxNode, exported = false): SymbolDef {
    const parent = this.scope;
    const qualified = parent ? `${parent.qualified}.${name}` : name;
    const existing = this.extract.symbols.find((s) => s.kind === kind && s.qualified === qualified);
    if (existing) {
      existing.exported ||= exported;
      return existing;
    }
    const def: SymbolDef = { kind, name, qualified, parent: parent?.qualified, startLine: line(node), endLine: node.endPosition.row + 1, exported };
    this.extract.symbols.push(def);
    return def;
  }

  call(callee: string, node: SyntaxNode, object?: string): void {
    const ref: CallRef = { from: this.scope?.qualified, callee, line: line(node) };
    if (object) ref.object = object;
    this.extract.calls.push(ref);
  }

  env(name: string, node: SyntaxNode): void {
    this.extract.env.push({ from: this.scope?.qualified, name, line: line(node) });
  }

  heritage(name: string, kind: 'EXTENDS' | 'IMPLEMENTS', node: SyntaxNode): void {
    const from = this.scope?.qualified;
    if (from) this.extract.heritage.push({ from, name, kind, line: line(node) });
  }

  /** Visits the subtree with `def` as the enclosing scope. */
  within(def: SymbolDef, node: SyntaxNode, visit: Visitor): void {
    this.scopes.push(def);
    this.walkChildren(node, visit, this.scopes.length);
    this.scopes.pop();
  }

  walk(root: SyntaxNode, visit: Visitor): void {
    this.walkChildren(root, visit, 0);
  }

  private walkChildren(node: SyntaxNode, visit: Visitor, depth: number): void {
    if (depth > MAX_DEPTH) return;
    for (const child of node.namedChildren) {
      if (!child) continue;
      const handled = visit(child, this);
      if (handled !== 'skip') this.walkChildren(child, visit, depth + 1);
    }
  }
}

/** Returning 'skip' means the visitor already handled the children (usually through `within`). */
export type Visitor = (node: SyntaxNode, b: FileBuilder) => 'skip' | void;

export { line as lineOf };
