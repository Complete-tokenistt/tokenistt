/**
 * Read-side view of a stored graph, shared by the browser viewer, impact analysis and the MCP tools. Held in memory
 * so traversal is cheap in both directions. Nodes form one tree for display: everything hangs off the repository,
 * and things with no place on disk (tables, packages, env vars) get a synthetic group.
 */
import type { Database } from '../store/db.js';
import { readEdges, readNodes } from './store.js';
import type { EdgeType, GraphEdge, GraphNode } from './schema.js';

export const ROOT_ID = 'dir:.';
const GROUPS: Record<string, { id: string; name: string }> = {
  table: { id: 'group:tables', name: 'Database tables' },
  package: { id: 'group:packages', name: 'External packages' },
  env_var: { id: 'group:env', name: 'Environment variables' },
};
/** Loose files at the top of a repository would otherwise crowd out the folders that matter. */
const ROOT_FILES = { id: 'group:root-files', name: 'Top-level files' };
/** Structure, not dependency: these don't make one thing depend on another. */
const STRUCTURAL = new Set<EdgeType>(['CONTAINS', 'EXPORTS']);
/** Edges meaning "source needs target", so walking them backwards finds what a change can affect. */
export const DEPENDENCY_TYPES: EdgeType[] = ['IMPORTS', 'CALLS', 'USES', 'EXTENDS', 'IMPLEMENTS', 'DEPENDS_ON', 'READS_FROM', 'WRITES_TO', 'CONNECTS_TO', 'TESTS'];

export interface ViewNode {
  id: string;
  type: string;
  name: string;
  path?: string;
  startLine?: number;
  /** How many nodes sit under this one in the display tree. */
  descendants: number;
  childCount: number;
  inferredOnly?: boolean;
}

export interface RolledEdge {
  source: string;
  target: string;
  count: number;
  types: Record<string, number>;
  /** Lowest confidence among the underlying edges. */
  confidence: number;
  /** True when every underlying edge was stated outright rather than inferred by name. */
  exact: boolean;
}

export interface Relation {
  id: string;
  name: string;
  type: string;
  path?: string;
  edge: string;
  confidence: number;
  resolution: string;
  line?: number;
}

export class GraphIndex {
  readonly nodes = new Map<string, GraphNode>();
  private readonly parents = new Map<string, string>();
  private readonly children = new Map<string, string[]>();
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();
  private readonly edges: GraphEdge[];
  private readonly sizes = new Map<string, number>();

  constructor(nodes: GraphNode[], edges: GraphEdge[]) {
    this.edges = edges;
    for (const n of nodes) this.nodes.set(n.id, n);
    for (const g of Object.values(GROUPS)) {
      if (nodes.some((n) => GROUPS[n.type]?.id === g.id)) this.nodes.set(g.id, { id: g.id, type: 'group', name: g.name, parent: ROOT_ID });
    }
    if (nodes.some((n) => n.type === 'file' && n.parent === ROOT_ID)) this.nodes.set(ROOT_FILES.id, { id: ROOT_FILES.id, type: 'group', name: ROOT_FILES.name, parent: ROOT_ID });
    for (const n of this.nodes.values()) {
      const parent = this.displayParent(n);
      if (!parent || !this.nodes.has(parent)) continue;
      this.parents.set(n.id, parent);
      const list = this.children.get(parent);
      if (list) list.push(n.id);
      else this.children.set(parent, [n.id]);
    }
    for (const e of edges) {
      (this.outgoing.get(e.source) ?? this.outgoing.set(e.source, []).get(e.source))?.push(e);
      (this.incoming.get(e.target) ?? this.incoming.set(e.target, []).get(e.target))?.push(e);
    }
    this.size(ROOT_ID);
  }

  static load(db: Database): GraphIndex {
    return new GraphIndex(readNodes(db), readEdges(db));
  }

  private displayParent(n: GraphNode): string | undefined {
    if (n.id === ROOT_ID) return undefined;
    const group = GROUPS[n.type];
    if (group) return group.id;
    // Modules duplicate the directory tree, so they stay out of it.
    if (n.type === 'module') return undefined;
    if (n.type === 'file' && n.parent === ROOT_ID) return ROOT_FILES.id;
    if (n.parent) return n.parent;
    if (n.path) return `file:${n.path}`;
    return undefined;
  }

  private size(id: string): number {
    let total = 0;
    const stack = [...(this.children.get(id) ?? [])];
    while (stack.length) {
      const next = stack.pop() as string;
      total++;
      for (const c of this.children.get(next) ?? []) stack.push(c);
    }
    this.sizes.set(id, total);
    for (const c of this.children.get(id) ?? []) if (!this.sizes.has(c)) this.size(c);
    return total;
  }

  view(id: string): ViewNode | undefined {
    const n = this.nodes.get(id);
    if (!n) return undefined;
    return {
      id: n.id, type: n.type, name: n.name,
      ...(n.path !== undefined ? { path: n.path } : {}), ...(n.startLine !== undefined ? { startLine: n.startLine } : {}),
      descendants: this.sizes.get(id) ?? 0, childCount: this.children.get(id)?.length ?? 0,
    };
  }

  /** Children, largest first, so a capped list shows what matters. */
  childrenOf(id: string, limit = 200): { items: ViewNode[]; total: number } {
    const ids = this.children.get(id) ?? [];
    const items = ids.map((c) => this.view(c)).filter((v): v is ViewNode => !!v)
      .sort((a, b) => b.descendants - a.descendants || a.name.localeCompare(b.name));
    return { items: items.slice(0, limit), total: items.length };
  }

  /** Path from the top of the tree down to this node, so a search hit can be revealed. */
  ancestors(id: string): string[] {
    const out: string[] = [];
    for (let at = this.parents.get(id); at; at = this.parents.get(at)) out.unshift(at);
    return out;
  }

  /**
   * Every dependency edge, moved up to the nearest visible ancestor at each end and merged. This is what lets a
   * collapsed directory show its real connections without the full graph being sent to the browser.
   */
  rollup(visible: Set<string>, types?: Set<string>): RolledEdge[] {
    const nearest = new Map<string, string | null>();
    const climb = (id: string): string | null => {
      const known = nearest.get(id);
      if (known !== undefined) return known;
      let at: string | undefined = id;
      while (at && !visible.has(at)) at = this.parents.get(at);
      const found = at ?? null;
      nearest.set(id, found);
      return found;
    };
    const merged = new Map<string, RolledEdge>();
    for (const e of this.edges) {
      if (STRUCTURAL.has(e.type) || (types && !types.has(e.type))) continue;
      const s = climb(e.source);
      const t = climb(e.target);
      if (!s || !t || s === t) continue;
      const key = `${s}\0${t}`;
      const exact = e.resolution === 'exact' || e.resolution === 'resolved';
      const m = merged.get(key);
      if (m) {
        m.count++;
        m.types[e.type] = (m.types[e.type] ?? 0) + 1;
        m.confidence = Math.min(m.confidence, e.confidence);
        m.exact &&= exact;
      } else {
        merged.set(key, { source: s, target: t, count: 1, types: { [e.type]: 1 }, confidence: e.confidence, exact });
      }
    }
    return [...merged.values()];
  }

  private relation(e: GraphEdge, otherId: string): Relation | undefined {
    const other = this.nodes.get(otherId);
    if (!other) return undefined;
    return {
      id: other.id, name: (other.metadata?.qualified as string | undefined) ?? other.name, type: other.type,
      ...(other.path !== undefined ? { path: other.path } : {}), edge: e.type, confidence: e.confidence, resolution: e.resolution,
      ...(e.line !== undefined ? { line: e.line } : {}),
    };
  }

  /** Direct relationships, including a file's symbols, because that is what someone means by "what uses this file". */
  relations(id: string, limit = 200): { incoming: Relation[]; outgoing: Relation[]; incomingTotal: number; outgoingTotal: number } {
    const collect = (map: Map<string, GraphEdge[]>, pick: (e: GraphEdge) => string) => {
      const out: Relation[] = [];
      for (const e of map.get(id) ?? []) {
        if (STRUCTURAL.has(e.type)) continue;
        const r = this.relation(e, pick(e));
        if (r) out.push(r);
      }
      return out.sort((a, b) => a.edge.localeCompare(b.edge) || a.name.localeCompare(b.name));
    };
    const incoming = collect(this.incoming, (e) => e.source);
    const outgoing = collect(this.outgoing, (e) => e.target);
    return { incoming: incoming.slice(0, limit), outgoing: outgoing.slice(0, limit), incomingTotal: incoming.length, outgoingTotal: outgoing.length };
  }

  /** The node itself plus its symbols: a change to a file is a change to everything in it. */
  private withContents(id: string): string[] {
    const out = [id];
    const stack = [...(this.children.get(id) ?? [])];
    while (stack.length) {
      const next = stack.pop() as string;
      out.push(next);
      for (const c of this.children.get(next) ?? []) stack.push(c);
    }
    return out;
  }

  /**
   * Breadth-first walk with the depth at which each node was first reached. `dependents` walks edges backwards:
   * what relies on this. `dependencies` walks forwards: what this relies on.
   */
  traverse(id: string, direction: 'dependents' | 'dependencies', opts: { maxDepth?: number; types?: EdgeType[]; limit?: number } = {}): Array<{ id: string; depth: number; via: string; confidence: number }> {
    const types = new Set<string>(opts.types ?? DEPENDENCY_TYPES);
    const maxDepth = opts.maxDepth ?? 6;
    const limit = opts.limit ?? 5000;
    const seen = new Set(this.withContents(id));
    const out: Array<{ id: string; depth: number; via: string; confidence: number }> = [];
    let frontier = [...seen].map((n) => ({ id: n, confidence: 1 }));
    for (let depth = 1; depth <= maxDepth && frontier.length && out.length < limit; depth++) {
      const next: Array<{ id: string; confidence: number }> = [];
      for (const at of frontier) {
        if (out.length >= limit) break;
        const list = direction === 'dependents' ? this.incoming.get(at.id) : this.outgoing.get(at.id);
        for (const e of list ?? []) {
          if (!types.has(e.type)) continue;
          const other = direction === 'dependents' ? e.source : e.target;
          if (seen.has(other) || !this.nodes.has(other)) continue;
          seen.add(other);
          // A chain is only as sure as its weakest link.
          const confidence = Math.min(at.confidence, e.confidence);
          out.push({ id: other, depth, via: e.type, confidence });
          next.push({ id: other, confidence });
          if (out.length >= limit) break;
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Substring search on names and paths, best matches first. */
  search(query: string, limit = 30): ViewNode[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored: Array<{ id: string; score: number }> = [];
    for (const n of this.nodes.values()) {
      if (n.type === 'module' || n.type === 'column') continue;
      const name = n.name.toLowerCase();
      const path = n.path?.toLowerCase() ?? '';
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 60;
      else if (path.includes(q)) score = 30;
      if (score === 0) continue;
      if (n.type === 'file' || n.type === 'function' || n.type === 'class' || n.type === 'endpoint' || n.type === 'component') score += 5;
      scored.push({ id: n.id, score });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, limit).map((s) => this.view(s.id)).filter((v): v is ViewNode => !!v);
  }

  /** Nodes most depended on, a useful starting point in an unfamiliar repository. */
  mostUsed(limit = 10): Array<ViewNode & { dependents: number }> {
    const out: Array<ViewNode & { dependents: number }> = [];
    for (const n of this.nodes.values()) {
      if (n.type === 'package' || n.type === 'env_var' || n.type === 'directory' || n.type === 'group' || n.type === 'repository') continue;
      const dependents = (this.incoming.get(n.id) ?? []).filter((e) => !STRUCTURAL.has(e.type)).length;
      const v = this.view(n.id);
      if (v && dependents > 0) out.push({ ...v, dependents });
    }
    return out.sort((a, b) => b.dependents - a.dependents || a.id.localeCompare(b.id)).slice(0, limit);
  }
}
