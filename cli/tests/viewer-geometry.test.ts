import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import GraphModule from 'graphology';
import type { GraphLike } from '../viewer/geometry.js';
import { convexHull, layerTargets, radialTargets, spiral } from '../viewer/geometry.js';
import { TYPE_COLOR, TYPE_PROGRAM, EDGE_COLOR, EDGE_LABEL, clusterColor, fade, rgba } from '../viewer/theme.js';
import { extractFile } from '../src/graph/languages/index.js';
import { linkGraph } from '../src/graph/linker.js';
import { GraphIndex } from '../src/graph/query.js';

type TestGraph = GraphLike & { addNode(id: string, attrs: object): void };
const Graph = GraphModule as unknown as new () => TestGraph;

describe('viewer geometry', () => {
  it('finds the convex hull, ignoring interior points and duplicates', () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [5, 5], [2, 3]]);
    assert.equal(hull.length, 4);
    assert.deepEqual(hull.map((p) => p.join(',')).sort(), ['0,0', '0,10', '10,0', '10,10']);
    assert.deepEqual(convexHull([[1, 1]]), [[1, 1]]);
    assert.equal(convexHull([[0, 0], [1, 1]]).length, 2);
    assert.equal(convexHull([[0, 0], [1, 1], [2, 2], [3, 3]]).length, 2, 'collinear points reduce to the ends');
  });

  it('spreads a spiral without overlap, and never starts everything at one point', () => {
    const pts = Array.from({ length: 200 }, (_, i) => spiral(i, 10));
    let closest = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) closest = Math.min(closest, Math.hypot((pts[i]?.x ?? 0) - (pts[j]?.x ?? 0), (pts[i]?.y ?? 0) - (pts[j]?.y ?? 0)));
    assert.ok(closest > 3, `closest pair ${closest}`);
  });

  const tree = (): { graph: TestGraph; parentOf: Map<string, string> } => {
    const graph = new Graph();
    const parentOf = new Map<string, string>([['dir:a', 'dir:.'], ['dir:b', 'dir:.'], ['a1', 'dir:a'], ['a2', 'dir:a'], ['a3', 'dir:a'], ['b1', 'dir:b']]);
    for (const id of ['a1', 'a2', 'a3', 'b1']) graph.addNode(id, { x: 0, y: 0 });
    return { graph, parentOf };
  };

  it('places every visible node on the radial layout, with siblings together and distinct places', () => {
    const { graph, parentOf } = tree();
    const t = radialTargets(graph, parentOf);
    assert.deepEqual(Object.keys(t).sort(), ['a1', 'a2', 'a3', 'b1']);
    const places = new Set(Object.values(t).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`));
    assert.equal(places.size, 4);
    for (const p of Object.values(t)) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    const angle = (id: string): number => Math.atan2(t[id]?.y ?? 0, t[id]?.x ?? 0);
    const wrap = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    // a-things share one arc of the circle; b1 sits in the other.
    const spreadA = Math.max(...['a1', 'a2', 'a3'].map((i) => wrap(angle(i)))) - Math.min(...['a1', 'a2', 'a3'].map((i) => wrap(angle(i))));
    assert.ok(spreadA < Math.PI * 1.2, 'siblings are grouped');
  });

  it('puts each nesting depth in its own row on the layered layout', () => {
    const { graph, parentOf } = tree();
    const t = layerTargets(graph, parentOf);
    assert.deepEqual(Object.keys(t).sort(), ['a1', 'a2', 'a3', 'b1']);
    assert.equal(new Set(Object.values(t).map((p) => p.y)).size, 1, 'all four are at the same depth');
    assert.equal(new Set(Object.values(t).map((p) => p.x)).size, 4);
  });

  it('copes with an empty graph', () => {
    assert.deepEqual(radialTargets(new Graph(), new Map()), {});
    assert.deepEqual(layerTargets(new Graph(), new Map()), {});
  });
});

describe('viewer theme', () => {
  it('colours every node and edge type it can show, and keeps shapes within the programs it registers', () => {
    for (const t of ['file', 'function', 'class', 'interface', 'endpoint', 'table', 'package', 'test']) assert.match(TYPE_COLOR[t] ?? '', /^#[0-9a-f]{6}$/i, t);
    for (const t of Object.keys(EDGE_LABEL)) assert.match(EDGE_COLOR[t] ?? '', /^#[0-9a-f]{6}$/i, t);
    for (const p of Object.values(TYPE_PROGRAM)) assert.ok(['circle', 'ring', 'square'].includes(p));
  });
  it('gives the same folder the same colour every time, and different folders different colours', () => {
    assert.equal(clusterColor('apps'), clusterColor('apps'));
    assert.notEqual(clusterColor('apps'), clusterColor('cli'));
  });
  it('mixes colours as valid CSS', () => {
    assert.equal(rgba('#ff0000', 0.5), 'rgba(255, 0, 0, 0.5)');
    assert.match(fade('#ffffff', 0.5), /^rgb\(\d+, \d+, \d+\)$/);
  });
});

describe('what the graph draws is what the backend knows', () => {
  async function index(files: Record<string, string>): Promise<GraphIndex> {
    const extracts = await Promise.all(Object.entries(files).map(([p, t]) => extractFile(p, t, 'sha', t.length)));
    const { nodes, edges } = linkGraph(extracts, 'repo');
    return new GraphIndex(nodes, edges);
  }
  const FILES = {
    'src/lib/db.ts': 'export function query() {}\n',
    'src/lib/users.ts': "import { query } from './db';\nexport function getUser() { query(); }\n",
    'src/api.ts': "import { getUser } from './lib/users';\nexport function handler() { getUser(); }\n",
    'src/unrelated.ts': 'export function alone() {}\n',
  };

  it('has a real relationship behind every rolled edge between files', async () => {
    const g = await index(FILES);
    const files = new Set(['file:src/lib/db.ts', 'file:src/lib/users.ts', 'file:src/api.ts', 'file:src/unrelated.ts']);
    const rolled = g.rollup(files);
    assert.ok(rolled.length >= 2);
    for (const e of rolled) {
      const rel = g.relations(e.source).outgoing.map((r) => r.id);
      assert.ok(rel.includes(e.target), `${e.source} -> ${e.target} is not a real relation`);
      assert.ok(e.count >= 1);
    }
    assert.equal(rolled.some((e) => e.source === 'file:src/unrelated.ts' || e.target === 'file:src/unrelated.ts'), false, 'no invented links to unrelated files');
  });

  it('keeps source references on the nodes it would show', async () => {
    const g = await index(FILES);
    const q = g.search('query')[0];
    assert.equal(q?.path, 'src/lib/db.ts');
    assert.equal(q?.startLine, 1);
    const detail = g.relations('sym:src/lib/db.ts#function:query');
    assert.ok(detail.incoming.some((r) => r.line !== undefined), 'a relation carries the line it was found on');
  });
});
