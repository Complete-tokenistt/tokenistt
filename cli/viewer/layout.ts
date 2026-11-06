/** Layouts. Force (ForceAtlas2) shows how things connect; radial and layered show how the folders nest. */
import type Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { animateNodes } from 'sigma/utils';
import type { Targets } from './geometry.js';

export { layerTargets, radialTargets, spiral } from './geometry.js';

export type LayoutName = 'force' | 'radial' | 'layers';

/** Pulls each node a little towards the centre of its own folder, so folders stay together as the force layout works. */
function cohesion(graph: Graph, parentOf: Map<string, string>, strength: number): void {
  const sums = new Map<string, { x: number; y: number; n: number }>();
  graph.forEachNode((id, a) => {
    const p = parentOf.get(id);
    if (!p) return;
    const s = sums.get(p) ?? { x: 0, y: 0, n: 0 };
    s.x += a.x as number; s.y += a.y as number; s.n++;
    sums.set(p, s);
  });
  graph.forEachNode((id, a) => {
    const p = parentOf.get(id);
    const s = p ? sums.get(p) : undefined;
    if (!s || s.n < 2) return;
    graph.mergeNodeAttributes(id, { x: (a.x as number) + (s.x / s.n - (a.x as number)) * strength, y: (a.y as number) + (s.y / s.n - (a.y as number)) * strength });
  });
}

/**
 * Keeps whole areas (the top-level folders) from lying on top of each other: each area's blob is pushed away from the
 * ones it overlaps, so the picture reads as separate islands joined by their real connections.
 */
function separateAreas(graph: Graph, strength: number): void {
  const areas = new Map<string, { x: number; y: number; ids: string[] }>();
  graph.forEachNode((id, a) => {
    const key = (a.cluster as string | undefined) ?? '';
    const s = areas.get(key) ?? { x: 0, y: 0, ids: [] };
    s.x += a.x as number; s.y += a.y as number; s.ids.push(id);
    areas.set(key, s);
  });
  const list = [...areas.values()].filter((a) => a.ids.length > 0);
  if (list.length < 2) return;
  const info = list.map((a) => {
    const cx = a.x / a.ids.length;
    const cy = a.y / a.ids.length;
    let spread = 0;
    for (const id of a.ids) spread += Math.hypot((graph.getNodeAttribute(id, 'x') as number) - cx, (graph.getNodeAttribute(id, 'y') as number) - cy);
    return { a, cx, cy, r: (spread / a.ids.length) * 1.7 + 8, dx: 0, dy: 0 };
  });
  for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
    const p = info[i]!; const q = info[j]!;
    let dx = q.cx - p.cx; let dy = q.cy - p.cy;
    let d = Math.hypot(dx, dy);
    if (d < 0.001) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = Math.hypot(dx, dy); }
    const overlap = p.r + q.r + 30 - d;
    if (overlap <= 0) continue;
    const push = overlap * strength;
    p.dx -= (dx / d) * push; p.dy -= (dy / d) * push; q.dx += (dx / d) * push; q.dy += (dy / d) * push;
  }
  for (const m of info) {
    if (!m.dx && !m.dy) continue;
    for (const id of m.a.ids) graph.mergeNodeAttributes(id, { x: (graph.getNodeAttribute(id, 'x') as number) + m.dx, y: (graph.getNodeAttribute(id, 'y') as number) + m.dy });
  }
}

export interface ForceRun { cancel: () => void; done: Promise<void> }

/**
 * Runs ForceAtlas2 in small slices between frames so the page never freezes and the graph visibly settles. It is
 * synchronous on purpose: the viewer's content policy does not allow web workers from blobs.
 */
export function runForce(graph: Graph, parentOf: Map<string, string>, onTick: () => void, opts: { iterations?: number; reduced?: boolean } = {}): ForceRun {
  const n = graph.order;
  let cancelled = false;
  let resolve: () => void = () => undefined;
  const done = new Promise<void>((r) => { resolve = r; });
  if (n < 2) { resolve(); return { cancel: () => undefined, done }; }
  const total = opts.iterations ?? (n > 3000 ? 160 : n > 1000 ? 220 : 320);
  const inferred = forceAtlas2.inferSettings(graph);
  const settings = { ...inferred, linLogMode: true, barnesHutOptimize: n > 250, gravity: 0.5, scalingRatio: (inferred.scalingRatio ?? 10) * 1.6, slowDown: 2, edgeWeightInfluence: 0.6 };
  let ran = 0;
  let chunk = 8;
  const step = (): void => {
    if (cancelled) return resolve();
    const t0 = performance.now();
    forceAtlas2.assign(graph, { iterations: chunk, settings });
    cohesion(graph, parentOf, 0.035);
    separateAreas(graph, 0.12);
    ran += chunk;
    const took = performance.now() - t0;
    // Aim for about 12ms of work per frame, whatever the graph size.
    chunk = Math.max(2, Math.min(40, Math.round(chunk * (12 / Math.max(1, took)))));
    onTick();
    if (ran >= total || opts.reduced) return resolve();
    requestAnimationFrame(step);
  };
  if (opts.reduced) {
    // Reduced motion: do all the work now and show only the result.
    const t0 = performance.now();
    while (ran < total && performance.now() - t0 < 1500) { forceAtlas2.assign(graph, { iterations: 10, settings }); cohesion(graph, parentOf, 0.035); separateAreas(graph, 0.12); ran += 10; }
    onTick();
    resolve();
  } else requestAnimationFrame(step);
  return { cancel: () => { cancelled = true; }, done };
}

export function animateTo(graph: Graph, targets: Targets, reduced: boolean, done?: () => void): () => void {
  const ids = Object.keys(targets).filter((id) => graph.hasNode(id));
  const clean: Targets = {};
  for (const id of ids) clean[id] = targets[id] as { x: number; y: number };
  if (reduced) {
    for (const id of ids) graph.mergeNodeAttributes(id, clean[id] as { x: number; y: number });
    done?.();
    return () => undefined;
  }
  return animateNodes(graph, clean, { duration: 600, easing: 'cubicInOut' }, done);
}
