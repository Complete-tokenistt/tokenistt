/** Structural analyses over the graph. All of it is computed from extracted edges; none of it needs a network. */
import { posix } from 'node:path';
import type { GraphEdge, GraphNode } from './schema.js';

export interface Analysis {
  cycles: string[][];
  isolated: string[];
  coupled: Array<{ path: string; fanIn: number; fanOut: number }>;
  boundaries: Array<{ from: string; to: string; imports: number }>;
  entryPoints: string[];
  duplicates: Array<{ name: string; bodySize: number; locations: string[] }>;
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|php|cs|c|cc|cpp|h|hpp)$/;
const isTest = (p: string): boolean => /(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\./.test(p) || /_test\./.test(p);

function fileImports(edges: GraphEdge[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.type !== 'IMPORTS' || !e.source.startsWith('file:') || !e.target.startsWith('file:')) continue;
    const set = out.get(e.source) ?? new Set<string>();
    set.add(e.target);
    out.set(e.source, set);
  }
  return out;
}

/** Tarjan's algorithm, iterative so a long import chain cannot overflow the stack. Components of 2+ files are cycles. */
export function findCycles(edges: GraphEdge[]): string[][] {
  const graph = fileImports(edges);
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; next: string[]; i: number }> = [];
    const open = (node: string): void => {
      index.set(node, counter);
      low.set(node, counter);
      counter++;
      stack.push(node);
      onStack.add(node);
      work.push({ node, next: [...(graph.get(node) ?? [])], i: 0 });
    };
    open(start);
    while (work.length) {
      const top = work[work.length - 1] as { node: string; next: string[]; i: number };
      if (top.i < top.next.length) {
        const w = top.next[top.i++] as string;
        if (!index.has(w)) open(w);
        else if (onStack.has(w)) low.set(top.node, Math.min(low.get(top.node) as number, index.get(w) as number));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(top.node) as number));
      if (low.get(top.node) === index.get(top.node)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop() as string;
          onStack.delete(w);
          comp.push(w);
        } while (w !== top.node);
        if (comp.length > 1) out.push(comp.map((c) => c.replace(/^file:/, '')).sort());
      }
    }
  }
  return out.sort((a, b) => b.length - a.length || (a[0] ?? '').localeCompare(b[0] ?? ''));
}

/** A top-level area for a path: the first two folders, or the first one for shallow paths. */
const area = (path: string): string => {
  const parts = posix.dirname(path).split('/');
  return parts[0] === '.' ? '(root)' : parts.slice(0, 2).join('/');
};

export function analyzeGraph(nodes: GraphNode[], edges: GraphEdge[]): Analysis {
  const files = nodes.filter((n) => n.type === 'file' && n.path && CODE.test(n.path)).map((n) => n.path as string);
  const imports = fileImports(edges);
  const fanOut = new Map<string, number>();
  const fanIn = new Map<string, number>();
  const boundary = new Map<string, number>();
  for (const [source, targets] of imports) {
    const from = source.replace(/^file:/, '');
    fanOut.set(from, targets.size);
    for (const t of targets) {
      const to = t.replace(/^file:/, '');
      fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
      const [a, b] = [area(from), area(to)];
      if (a !== b) boundary.set(`${a}\0${b}`, (boundary.get(`${a}\0${b}`) ?? 0) + 1);
    }
  }
  const entry = nodes.filter((n) => n.metadata?.entryPoint === true && n.path).map((n) => n.path as string);
  const routed = new Set(nodes.filter((n) => n.type === 'endpoint' && n.path).map((n) => n.path as string));
  const isolated = files.filter((f) => !fanIn.get(f) && !fanOut.get(f) && !isTest(f) && !entry.includes(f) && !routed.has(f));

  // Same name and same size in different files is only a lead for a person to check, not proof of duplication.
  const bySignature = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if ((n.type !== 'function' && n.type !== 'method') || !n.path || isTest(n.path) || !n.startLine || !n.endLine) continue;
    const size = n.endLine - n.startLine + 1;
    if (size < 5) continue;
    const key = `${n.name}\0${size}`;
    bySignature.set(key, [...(bySignature.get(key) ?? []), n]);
  }
  const duplicates = [...bySignature.entries()].filter(([, v]) => new Set(v.map((n) => n.path)).size > 1)
    .map(([key, v]) => ({ name: key.split('\0')[0] ?? '', bodySize: Number(key.split('\0')[1]), locations: v.map((n) => `${n.path}:${n.startLine}`).sort() }))
    .sort((a, b) => b.bodySize - a.bodySize || a.name.localeCompare(b.name));

  return {
    cycles: findCycles(edges),
    isolated: isolated.sort(),
    coupled: files.map((path) => ({ path, fanIn: fanIn.get(path) ?? 0, fanOut: fanOut.get(path) ?? 0 })).filter((f) => f.fanIn >= 5 && f.fanOut >= 5).sort((a, b) => b.fanIn * b.fanOut - a.fanIn * a.fanOut),
    boundaries: [...boundary].map(([k, n]) => ({ from: k.split('\0')[0] ?? '', to: k.split('\0')[1] ?? '', imports: n })).sort((a, b) => b.imports - a.imports),
    entryPoints: [...new Set([...entry, ...files.filter((f) => !fanIn.get(f) && (fanOut.get(f) ?? 0) > 0 && !isTest(f))])].sort(),
    duplicates,
  };
}

export interface Trace {
  route: string;
  path: string;
  steps: Array<{ depth: number; name: string; type: string; where: string }>;
  tables: Array<{ name: string; access: string }>;
}

/** Follows one API route forward through handlers and calls to the tables it reaches. */
export function traceRoute(endpoint: GraphNode, nodes: Map<string, GraphNode>, edges: GraphEdge[], maxDepth = 6): Trace {
  const out = new Map<string, GraphEdge[]>();
  const into = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    out.set(e.source, [...(out.get(e.source) ?? []), e]);
    into.set(e.target, [...(into.get(e.target) ?? []), e]);
  }
  const handlers = (into.get(endpoint.id) ?? []).filter((e) => e.type === 'CONNECTS_TO').map((e) => e.source);
  const seen = new Set<string>([endpoint.id]);
  let frontier = [endpoint.id, ...handlers];
  for (const h of handlers) seen.add(h);
  const steps: Trace['steps'] = [];
  const tables = new Map<string, string>();
  const describe = (id: string, depth: number): void => {
    const n = nodes.get(id);
    if (n) steps.push({ depth, name: (n.metadata?.qualified as string | undefined) ?? n.name, type: n.type, where: n.path ? `${n.path}${n.startLine ? `:${n.startLine}` : ''}` : '' });
  };
  for (const h of handlers) describe(h, 1);
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of out.get(id) ?? []) {
        if (e.type === 'READS_FROM' || e.type === 'WRITES_TO') {
          const name = nodes.get(e.target)?.name;
          if (name) tables.set(name, e.type === 'WRITES_TO' || tables.get(name) === 'writes' ? 'writes' : 'reads');
        }
        if (e.type !== 'CALLS' || seen.has(e.target)) continue;
        seen.add(e.target);
        describe(e.target, depth + 1);
        next.push(e.target);
      }
    }
    frontier = next;
  }
  return { route: endpoint.name, path: endpoint.path ?? '', steps, tables: [...tables].map(([name, access]) => ({ name, access })).sort((a, b) => a.name.localeCompare(b.name)) };
}
