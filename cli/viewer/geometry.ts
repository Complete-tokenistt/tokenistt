/** Pure geometry for the graph viewer. No browser APIs, so it can be tested in Node. */
/** The little of a Graphology graph these functions use, so they do not depend on its types. */
export interface GraphLike {
  forEachNode(cb: (id: string, attrs: Record<string, unknown>) => void): void;
  hasNode(id: string): boolean;
}

export type Pt = [number, number];
export type Targets = Record<string, { x: number; y: number }>;

/** Fresh nodes start on a sunflower spiral, which spreads them evenly instead of starting as one clump. */
export function spiral(i: number, spacing: number): { x: number; y: number } {
  const a = i * 2.399963;
  const r = spacing * Math.sqrt(i + 0.5);
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew's monotone chain. */
export function convexHull(points: Pt[]): Pt[] {
  if (points.length < 3) return points.slice();
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Pt[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2] as Pt, lower[lower.length - 1] as Pt, q) <= 0) lower.pop(); lower.push(q); }
  const upper: Pt[] = [];
  for (const q of p.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2] as Pt, upper[upper.length - 1] as Pt, q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

interface TreeInfo { depth: Map<string, number>; leaves: string[]; weight: Map<string, number>; kids: Map<string, string[]>; roots: string[] }

/** The folder tree restricted to what is on screen, in a stable order so repeated layouts do not shuffle. */
function visibleTree(graph: GraphLike, parentOf: Map<string, string>): TreeInfo {
  const kids = new Map<string, string[]>();
  const seen = new Set<string>();
  const add = (child: string, parent: string | undefined): void => {
    const key = parent ?? '';
    const list = kids.get(key) ?? [];
    if (!list.includes(child)) list.push(child);
    kids.set(key, list);
  };
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const p = parentOf.get(id);
    add(id, p);
    if (p) walk(p);
  };
  const leaves: string[] = [];
  graph.forEachNode((id) => { leaves.push(id); walk(id); });
  for (const list of kids.values()) list.sort();
  const depth = new Map<string, number>();
  const weight = new Map<string, number>();
  const roots = kids.get('') ?? [];
  const visit = (id: string, d: number): number => {
    depth.set(id, d);
    const ch = kids.get(id);
    const w = ch && ch.length ? ch.reduce((s, c) => s + visit(c, d + 1), 0) : 1;
    weight.set(id, w);
    return w;
  };
  roots.forEach((r) => visit(r, 0));
  return { depth, leaves, weight, kids, roots };
}

export function radialTargets(graph: GraphLike, parentOf: Map<string, string>): Targets {
  const t = visibleTree(graph, parentOf);
  const out: Targets = {};
  const perDepth = new Map<number, number>();
  for (const id of t.leaves) perDepth.set(t.depth.get(id) ?? 0, (perDepth.get(t.depth.get(id) ?? 0) ?? 0) + 1);
  const radius = new Map<number, number>();
  let prev = 0;
  const maxDepth = Math.max(0, ...perDepth.keys());
  for (let d = 0; d <= maxDepth; d++) {
    // Each ring is wide enough to hold its members without touching, and always outside the one before.
    prev = Math.max(prev + 90, ((perDepth.get(d) ?? 0) * 9) / (2 * Math.PI));
    radius.set(d, prev);
  }
  const place = (id: string, from: number, to: number): void => {
    const mid = (from + to) / 2;
    const d = t.depth.get(id) ?? 0;
    if (graph.hasNode(id)) { const r = radius.get(d) ?? 0; out[id] = { x: Math.cos(mid) * r, y: Math.sin(mid) * r }; }
    const ch = t.kids.get(id) ?? [];
    const total = ch.reduce((s, c) => s + (t.weight.get(c) ?? 1), 0) || 1;
    let a = from;
    for (const c of ch) { const span = ((to - from) * (t.weight.get(c) ?? 1)) / total; place(c, a, a + span); a += span; }
  };
  const total = t.roots.reduce((s, r) => s + (t.weight.get(r) ?? 1), 0) || 1;
  let a = 0;
  for (const r of t.roots) { const span = (Math.PI * 2 * (t.weight.get(r) ?? 1)) / total; place(r, a, a + span); a += span; }
  return out;
}

/**
 * One band per folder depth, outermost first. Each band flows left to right in tree order and wraps, so a thousand
 * files make a block you can read instead of a line a hundred screens wide.
 */
export function layerTargets(graph: GraphLike, parentOf: Map<string, string>): Targets {
  const t = visibleTree(graph, parentOf);
  const order: string[] = [];
  const walk = (id: string): void => { if (graph.hasNode(id)) order.push(id); (t.kids.get(id) ?? []).forEach(walk); };
  t.roots.forEach(walk);
  const byDepth = new Map<number, string[]>();
  for (const id of order) { const d = t.depth.get(id) ?? 0; (byDepth.get(d) ?? byDepth.set(d, []).get(d))?.push(id); }
  const gap = 16;
  const width = Math.max(600, Math.sqrt(order.length) * gap * 2.4);
  const perRow = Math.max(1, Math.floor(width / gap));
  const out: Targets = {};
  let y = 0;
  for (const d of [...byDepth.keys()].sort((p, q) => p - q)) {
    const ids = byDepth.get(d) ?? [];
    ids.forEach((id, i) => { out[id] = { x: (i % perRow) * gap, y: y + Math.floor(i / perRow) * gap }; });
    y += Math.ceil(ids.length / perRow) * gap + 90;
  }
  return out;
}
