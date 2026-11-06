/**
 * The browser side of the graph viewer: Sigma (WebGL) draws a Graphology graph that holds only what is open.
 * Folders are rings that stand for everything inside them; opening one swaps the ring for its contents inside a soft
 * outline. Every line on screen comes from the backend's roll-up of real relationships, never from this file.
 */
import Graph from 'graphology';
import Sigma from 'sigma';
import { NodeCircleProgram } from 'sigma/rendering';
import type { NodeLabelDrawingFunction, NodeHoverDrawingFunction } from 'sigma/rendering';
import { createEdgeCurveProgram } from '@sigma/edge-curve';
import { createNodeBorderProgram } from '@sigma/node-border';
import { NodeSquareProgram } from '@sigma/node-square';
import { Hulls, type HullGroup } from './hulls.js';
import { animateTo, layerTargets, radialTargets, runForce, spiral, type ForceRun, type LayoutName } from './layout.js';
import {
  BACKGROUND, EDGE_COLOR, EDGE_LABEL, IMPACT_COLOR, IN_COLOR, OUT_COLOR, TYPE_COLOR, TYPE_LABEL, TYPE_PROGRAM, TYPE_SINGULAR, TYPE_SIZE,
  clusterColor, fade, rgba,
} from './theme.js';

interface ViewNode { id: string; type: string; name: string; path?: string; startLine?: number; descendants: number; childCount: number }
interface RolledEdge { source: string; target: string; count: number; types: Record<string, number>; exact: boolean }
interface Relation { id: string; name: string; type: string; path?: string; edge: string; resolution: string; confidence: number; line?: number }
interface NodeDetail {
  node: { id: string; type: string; name: string; path?: string; startLine?: number; endLine?: number; language?: string; metadata?: Record<string, unknown> };
  view: ViewNode;
  incoming: Relation[]; outgoing: Relation[]; incomingTotal: number; outgoingTotal: number;
  history: Array<{ commit: string; date: string; subject: string }>;
  sessions: Array<{ agent: string; id: string; lastEventAt: string; touches: number; changed: boolean }>;
}
interface Overview {
  metadata: { generatedAt: string; repository: { name: string; branch: string | null; commit: string | null }; nodes: Record<string, number>; edges: Record<string, number> } | null;
  root: ViewNode | null;
  children: { items: ViewNode[]; total: number };
}

const ROOT = 'dir:.';
const MAX_NODES = 3200;
const TOKEN = new URLSearchParams(location.search).get('t') ?? '';
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, { ...init, headers: { 'x-tokenistt-token': TOKEN, ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return (await res.json()) as T;
};

// ── State ───────────────────────────────────────────────────────────────────────────────────────────────────────
const graph = new Graph({ type: 'directed', multi: false });
const known = new Map<string, ViewNode>();
const parentOf = new Map<string, string>();
const expanded = new Set<string>();
/** What the person opened, even if a filter currently hides it, so showing a type again brings its contents back. */
const wanted = new Set<string>();
const childCache = new Map<string, { items: ViewNode[]; total: number }>();
const lastPos = new Map<string, { x: number; y: number }>();
const hiddenTypes = new Set<string>(['column', 'variable', 'type']);
const hiddenEdges = new Set<string>(['DOCUMENTED_BY']);
const hiddenAreas = new Set<string>();
let mode: 'map' | 'focus' = 'map';
let layoutName: LayoutName = 'force';
let selected: string | undefined;
let hovered: string | undefined;
let around: { id: string; neighbors: Set<string> } | undefined;
let impact: Map<string, number> | undefined;
let snapshot: ReturnType<Graph['export']> | undefined;
let force: ForceRun | undefined;
let stopAnimation: (() => void) | undefined;
let rippleTimers: number[] = [];

// ── Rendering set-up ────────────────────────────────────────────────────────────────────────────────────────────
const RingProgram = createNodeBorderProgram({
  borders: [{ size: { value: 0.28 }, color: { attribute: 'borderColor' } }, { size: { fill: true }, color: { value: '#0d1620' } }],
});
const CurvedArrow = createEdgeCurveProgram({ curvatureAttribute: 'curvature', defaultCurvature: 0.22, arrowHead: { extremity: 'target', lengthToThicknessRatio: 5, widenessToThicknessRatio: 4 } });

const drawLabel: NodeLabelDrawingFunction = (ctx, data, settings) => {
  if (!data.label) return;
  const size = settings.labelSize;
  ctx.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
  const x = data.x + data.size + 4;
  const y = data.y + size / 3;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = BACKGROUND;
  ctx.strokeText(data.label, x, y);
  ctx.fillStyle = '#d3dfe9';
  ctx.fillText(data.label, x, y);
};
// Hover is shown by the node reducer (bigger, labelled), so Sigma's own hover layer draws nothing that could go stale.
const drawHover: NodeHoverDrawingFunction = () => undefined;

const sigma = new Sigma(graph, $('graph'), {
  defaultNodeType: 'circle',
  defaultEdgeType: 'curved',
  nodeProgramClasses: { circle: NodeCircleProgram, ring: RingProgram, square: NodeSquareProgram },
  edgeProgramClasses: { curved: CurvedArrow },
  labelFont: '"Segoe UI", system-ui, sans-serif',
  labelSize: 12,
  labelWeight: '500',
  labelColor: { color: '#d3dfe9' },
  labelRenderedSizeThreshold: 6,
  labelDensity: 0.25,
  labelGridCellSize: 180,
  defaultDrawNodeLabel: drawLabel,
  defaultDrawNodeHover: drawHover,
  zIndex: true,
  minCameraRatio: 0.015,
  maxCameraRatio: 14,
  stagePadding: 60,
  allowInvalidContainer: false,
  nodeReducer: (id, d) => {
    const res = { ...d };
    const cluster = d.cluster as string | undefined;
    if (mode === 'map' && cluster && hiddenAreas.has(cluster)) { res.hidden = true; return res; }
    if (impact) {
      const depth = impact.get(id);
      if (depth !== undefined) { res.color = fade(IMPACT_COLOR, Math.min(0.55, (depth - 1) * 0.14)); res.borderColor = res.color; res.zIndex = 3; res.forceLabel = depth <= 2; if (id === selected) res.size = (d.size as number) * 1.5; }
      else if (id !== selected) { res.color = fade(d.color as string, 0.82); res.borderColor = res.color; res.label = ''; res.zIndex = 0; }
      return res;
    }
    if (around) {
      if (id === around.id) { res.size = (d.size as number) * 1.45; res.zIndex = 4; res.forceLabel = true; }
      else if (around.neighbors.has(id)) { res.zIndex = 3; res.forceLabel = true; }
      else { res.color = fade(d.color as string, 0.8); res.borderColor = res.color; res.label = ''; res.zIndex = 0; }
    }
    if (id === hovered) { res.zIndex = 5; res.forceLabel = true; res.size = (res.size as number) * 1.3; }
    return res;
  },
  edgeReducer: (_e, d) => {
    const res = { ...d };
    if (impact) { res.color = rgba(IMPACT_COLOR, 0.03); res.zIndex = 0; return res; }
    const [s, t] = graph.extremities(_e);
    const touching = (around && (s === around.id || t === around.id)) || (hovered && (s === hovered || t === hovered));
    if (d.quiet && !touching) { res.hidden = true; return res; }
    if (hovered && !around && touching) { res.color = rgba(s === hovered ? OUT_COLOR : IN_COLOR, 0.9); res.zIndex = 3; }
    if (around) {
      if (s === around.id) { res.color = rgba(OUT_COLOR, 0.95); res.size = (d.size as number) * 1.9 + 0.4; res.zIndex = 3; }
      else if (t === around.id) { res.color = rgba(IN_COLOR, 0.95); res.size = (d.size as number) * 1.9 + 0.4; res.zIndex = 3; }
      else { res.color = rgba('#445566', 0.05); res.zIndex = 0; }
    }
    return res;
  },
});

const hulls = new Hulls($('hulls') as HTMLCanvasElement, sigma, graph);
sigma.on('afterRender', () => { hulls.draw((g) => !hiddenAreas.has(g.cluster)); scheduleMinimap(); });

// ── Structure helpers ───────────────────────────────────────────────────────────────────────────────────────────
function clusterOf(id: string): string {
  let cur = id;
  for (let i = 0; i < 64; i++) {
    const p = parentOf.get(cur);
    if (!p || p === ROOT) return known.get(cur)?.name ?? cur;
    cur = p;
  }
  return cur;
}

function ancestorsOf(id: string): string[] {
  const out: string[] = [];
  let cur = parentOf.get(id);
  for (let i = 0; cur && cur !== ROOT && i < 64; i++) { out.push(cur); cur = parentOf.get(cur); }
  return out;
}

const isContainer = (v: ViewNode): boolean => v.childCount > 0;

function nodeAttributes(v: ViewNode, pos: { x: number; y: number }): Record<string, unknown> {
  const cluster = clusterOf(v.id);
  const container = isContainer(v);
  const color = container ? clusterColor(cluster) : (TYPE_COLOR[v.type] ?? '#8ba0b2');
  const program = container ? 'ring' : (TYPE_PROGRAM[v.type] ?? 'circle');
  return {
    x: pos.x, y: pos.y, label: container ? `${v.name}  ${v.descendants}` : v.name, color, borderColor: color, type: program, kind: v.type, cluster,
    size: container ? Math.min(22, 7 + Math.sqrt(v.descendants) * 0.9) : (TYPE_SIZE[v.type] ?? 3.5),
  };
}

function buildGroups(): HullGroup[] {
  const members = new Map<string, string[]>();
  graph.forEachNode((id) => { for (const a of ancestorsOf(id)) (members.get(a) ?? members.set(a, []).get(a))?.push(id); });
  return [...members.entries()].map(([id, list]) => ({
    id, name: known.get(id)?.name ?? id, color: clusterColor(clusterOf(id)), cluster: clusterOf(id), depth: ancestorsOf(id).length, members: list,
  }));
}

/** Sigma keeps its own idea of what is under the pointer; a synthetic move off the canvas makes it let go after the graph changes. */
function clearHover(): void {
  hovered = undefined;
  $('tip').hidden = true;
  document.querySelector('#graph .sigma-mouse')?.dispatchEvent(new MouseEvent('mousemove', { clientX: -5, clientY: -5, bubbles: true }));
  // The hover layer is only repainted while something is hovered, so wipe what was left on it.
  const layer = document.querySelector<HTMLCanvasElement>('#graph .sigma-hovers');
  layer?.getContext('2d')?.clearRect(0, 0, layer.width, layer.height);
}

function structureChanged(): void {
  clearHover();
  hulls.set(buildGroups());
  if (mode === 'map') $('stats-live').textContent = `${graph.order.toLocaleString()} shown`;
}

const statusEl = $('status');
let statusTimer = 0;
function say(text: string, ms = 0): void {
  statusEl.hidden = !text;
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  if (text && ms) statusTimer = window.setTimeout(() => { statusEl.hidden = true; }, ms);
}

// ── Edges, always from the backend roll-up ──────────────────────────────────────────────────────────────────────
async function refreshEdges(): Promise<void> {
  if (mode !== 'map') return;
  const types = Object.keys(EDGE_LABEL).filter((t) => !hiddenEdges.has(t));
  const { edges } = await api<{ edges: RolledEdge[] }>('/api/subgraph', { method: 'POST', body: JSON.stringify({ visible: graph.nodes(), types }) });
  graph.clearEdges();
  for (const e of edges) {
    if (e.source === e.target || !graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
    const dominant = Object.entries(e.types).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USES';
    const base = EDGE_COLOR[dominant] ?? '#8c9aa6';
    graph.addEdgeWithKey(`${e.source}->${e.target}`, e.source, e.target, {
      // Stated in the code: clear. Inferred from names: the same colour, paler, so doubt is visible at a glance.
      color: rgba(base, e.exact ? (graph.order > 300 ? 0.38 : 0.6) : 0.2), baseColor: base, size: 0.7 + Math.min(2.4, Math.log2(e.count + 1) * 0.55), curvature: 0.22,
      weight: 1 + Math.log2(e.count), count: e.count, exact: e.exact, types: e.types, type: 'curved', quiet: false,
    });
  }
  limitEdges();
  recomputeAround();
}

/**
 * With hundreds of things open, every line at once is a hairball. Only the strongest connections stay drawn; selecting
 * or hovering something shows all of its own. Nothing is removed from the graph, only hidden.
 */
function limitEdges(): void {
  const budget = graph.order <= 80 ? Infinity : Math.max(140, Math.round(graph.order * (graph.order > 300 ? 0.5 : 0.8)));
  const all = graph.edges();
  const keep = new Set<string>();
  if (all.length <= budget) all.forEach((e) => keep.add(e));
  else {
    // Lines between different areas come first: they are the architecture. Within an area, the strongest.
    const score = (e: string): number => { const [s, t] = graph.extremities(e); const cross = graph.getNodeAttribute(s, 'cluster') !== graph.getNodeAttribute(t, 'cluster'); return (graph.getEdgeAttribute(e, 'count') as number) * (cross ? 4 : 1) * (graph.getEdgeAttribute(e, 'exact') ? 1.2 : 1); };
    const ranked = all.map((e) => ({ e, s: score(e) })).sort((x, y) => y.s - x.s);
    ranked.slice(0, budget).forEach((r) => keep.add(r.e));
  }
  for (const e of all) graph.setEdgeAttribute(e, 'quiet', !keep.has(e));
  $('stats-live').textContent = `${graph.order.toLocaleString()} shown${all.length > keep.size ? `, ${keep.size.toLocaleString()} of ${all.length.toLocaleString()} links drawn` : ''}`;
}

function recomputeAround(): void {
  if (selected && graph.hasNode(selected)) around = { id: selected, neighbors: new Set(graph.neighbors(selected)) };
  else around = undefined;
  sigma.refresh();
}

// ── Layout ──────────────────────────────────────────────────────────────────────────────────────────────────────
function tick(): void {
  hulls.markDirty();
}

function savePositions(): void {
  graph.forEachNode((id, a) => lastPos.set(id, { x: a.x as number, y: a.y as number }));
}

function stopLayouts(): void {
  force?.cancel();
  stopAnimation?.();
  force = undefined;
  stopAnimation = undefined;
}

/** Lays out what is on screen. `full` is a fresh arrangement; otherwise it only relaxes what is already placed. */
async function applyLayout(full: boolean): Promise<void> {
  if (mode !== 'map') return;
  stopLayouts();
  if (layoutName === 'force') {
    force = runForce(graph, parentOf, tick, { iterations: full ? undefined : 90, reduced: REDUCED_MOTION });
    await force.done;
  } else {
    const targets = layoutName === 'radial' ? radialTargets(graph, parentOf) : layerTargets(graph, parentOf);
    await new Promise<void>((resolve) => { stopAnimation = animateTo(graph, targets, REDUCED_MOTION, resolve); });
  }
  tick();
  sigma.refresh();
}

// ── Opening and closing folders ─────────────────────────────────────────────────────────────────────────────────
async function children(id: string): Promise<{ items: ViewNode[]; total: number }> {
  const hit = childCache.get(id);
  if (hit) return hit;
  const data = await api<{ items: ViewNode[]; total: number }>(`/api/children?id=${encodeURIComponent(id)}`);
  childCache.set(id, data);
  return data;
}

async function expand(id: string, relayout = true): Promise<boolean> {
  if (expanded.has(id)) return false;
  const { items } = await children(id);
  const shown = items.filter((v) => !hiddenTypes.has(v.type));
  if (shown.length === 0) return false;
  expanded.add(id);
  wanted.add(id);
  const base = graph.hasNode(id) ? { x: graph.getNodeAttribute(id, 'x') as number, y: graph.getNodeAttribute(id, 'y') as number } : (lastPos.get(id) ?? { x: 0, y: 0 });
  lastPos.set(id, base);
  if (graph.hasNode(id)) graph.dropNode(id);
  const spacing = id === ROOT ? 90 : Math.max(5, Math.min(14, 40 / Math.sqrt(shown.length)));
  shown.forEach((v, i) => {
    known.set(v.id, v);
    parentOf.set(v.id, id);
    if (graph.hasNode(v.id)) return;
    const seed = lastPos.get(v.id);
    const s = spiral(i, spacing);
    graph.addNode(v.id, nodeAttributes(v, seed ?? { x: base.x + s.x, y: base.y + s.y }));
  });
  structureChanged();
  if (relayout) {
    await refreshEdges();
    await applyLayout(false);
  }
  return true;
}

function collapse(id: string): void {
  if (id === ROOT || !expanded.has(id)) return;
  const inside: string[] = [];
  graph.forEachNode((n) => { if (ancestorsOf(n).includes(id)) inside.push(n); });
  let cx = 0;
  let cy = 0;
  for (const n of inside) { cx += graph.getNodeAttribute(n, 'x') as number; cy += graph.getNodeAttribute(n, 'y') as number; graph.dropNode(n); }
  for (const e of [...expanded]) if (e === id || ancestorsOf(e).includes(id)) expanded.delete(e);
  for (const e of [...wanted]) if (e === id || ancestorsOf(e).includes(id)) wanted.delete(e);
  const v = known.get(id);
  if (v) graph.addNode(id, nodeAttributes(v, inside.length ? { x: cx / inside.length, y: cy / inside.length } : (lastPos.get(id) ?? { x: 0, y: 0 })));
  structureChanged();
  recomputeAround();
}

async function toggle(id: string): Promise<void> {
  if (expanded.has(id)) collapse(id);
  else if (!(await expand(id))) return;
  await refreshEdges();
  await applyLayout(false);
}

/** Opens every folder that is on screen, one level, stopping before the picture gets too heavy to read. */
async function openLevel(): Promise<void> {
  const targets = graph.filterNodes((id) => !expanded.has(id) && (known.get(id)?.childCount ?? 0) > 0);
  if (targets.length === 0) { say('Nothing left to open.', 2500); return; }
  say(`Opening ${targets.length} folders...`);
  for (let i = 0; i < targets.length; i += 24) await Promise.all(targets.slice(i, i + 24).map((t) => children(t)));
  let opened = 0;
  for (const t of targets) {
    if (graph.order >= MAX_NODES) break;
    if (await expand(t, false)) opened++;
  }
  await refreshEdges();
  await applyLayout(true);
  say(graph.order >= MAX_NODES ? `Stopped at ${graph.order.toLocaleString()} nodes to keep it readable. Open folders one at a time, or search.` : `Opened ${opened} folders.`, 4000);
}

/** Opens the tree down to a node, then selects it. Used by search, recent changes and the inspector. */
async function reveal(id: string): Promise<void> {
  if (mode === 'focus') { await enterFocus(id); return; }
  const { ids } = await api<{ ids: string[] }>(`/api/ancestors?id=${encodeURIComponent(id)}`);
  let changed = false;
  for (const a of ids) if (a !== ROOT && (await expand(a, false))) changed = true;
  if (changed) {
    await refreshEdges();
    await applyLayout(false);
  }
  if (graph.hasNode(id)) centerOn(id, 0.4);
  await select(id);
}

// ── Camera ──────────────────────────────────────────────────────────────────────────────────────────────────────
const camera = sigma.getCamera();
function centerAt(x: number, y: number, ratio?: number): void {
  const f = sigma.viewportToFramedGraph(sigma.graphToViewport({ x, y }));
  camera.animate({ x: f.x, y: f.y, ...(ratio !== undefined ? { ratio } : {}) }, { duration: REDUCED_MOTION ? 0 : 350 });
}
function centerOn(id: string, ratio?: number): void {
  if (!graph.hasNode(id)) return;
  centerAt(graph.getNodeAttribute(id, 'x') as number, graph.getNodeAttribute(id, 'y') as number, ratio !== undefined ? Math.min(camera.ratio, ratio) : undefined);
}
function fit(): void {
  camera.animatedReset({ duration: REDUCED_MOTION ? 0 : 350 });
}
function zoomToArea(cluster: string): void {
  const pts: Array<[number, number]> = [];
  graph.forEachNode((_id, a) => { if (a.cluster === cluster) pts.push([a.x as number, a.y as number]); });
  if (!pts.length) return;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const box = sigma.getBBox();
  const gw = Math.max(1, box.x[1] - box.x[0]);
  const gh = Math.max(1, box.y[1] - box.y[0]);
  const ratio = Math.max(0.03, Math.min(1.2, Math.max((Math.max(...xs) - Math.min(...xs)) / gw, (Math.max(...ys) - Math.min(...ys)) / gh) * 1.35));
  centerAt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, ratio);
}

// ── Inspector ───────────────────────────────────────────────────────────────────────────────────────────────────
function relationList(title: string, items: Relation[], total: number): HTMLElement {
  const frag = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = `${title} (${total})`;
  frag.append(h);
  if (items.length === 0) {
    const none = document.createElement('p');
    none.className = 'more';
    none.textContent = 'None.';
    frag.append(none);
    return frag;
  }
  const ul = document.createElement('ul');
  ul.className = 'relations';
  for (const r of items) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name;
    const small = document.createElement('small');
    const inferred = r.resolution !== 'exact' && r.resolution !== 'resolved';
    if (inferred) small.className = 'inferred';
    small.textContent = `${EDGE_LABEL[r.edge] ?? r.edge}${inferred ? `, inferred (${Math.round(r.confidence * 100)}%)` : ''}${r.path ? `, ${r.path}` : ''}${r.line ? `:${r.line}` : ''}`;
    b.append(name, small);
    b.addEventListener('click', () => void reveal(r.id));
    li.append(b);
    ul.append(li);
  }
  frag.append(ul);
  if (total > items.length) {
    const more = document.createElement('p');
    more.className = 'more';
    more.textContent = `Showing ${items.length} of ${total}.`;
    frag.append(more);
  }
  return frag;
}

/** A folder has no relations of its own; what connects it to the rest is the sum of what is inside, as drawn on the map. */
function areaLinks(id: string): HTMLElement {
  const frag = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = 'Connected areas';
  frag.append(h);
  const rows: Array<{ other: string; incoming: boolean; count: number; types: Record<string, number> }> = [];
  if (graph.hasNode(id)) {
    graph.forEachOutEdge(id, (_e, a, _s, t) => rows.push({ other: t, incoming: false, count: a.count as number, types: a.types as Record<string, number> }));
    graph.forEachInEdge(id, (_e, a, s) => rows.push({ other: s, incoming: true, count: a.count as number, types: a.types as Record<string, number> }));
  }
  const note = document.createElement('p');
  note.className = 'more';
  if (rows.length === 0) {
    note.textContent = graph.hasNode(id) ? 'Nothing outside this folder is connected to what is inside it.' : 'This folder is open. Select something inside it to see what it connects to.';
    frag.append(note);
    return frag;
  }
  rows.sort((a, b) => b.count - a.count);
  const ul = document.createElement('ul');
  ul.className = 'relations';
  for (const r of rows.slice(0, 40)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${r.incoming ? '← ' : '→ '}${String(graph.getNodeAttribute(r.other, 'label')).replace(/\s{2,}\d+$/, '')}`;
    const small = document.createElement('small');
    small.textContent = `${Object.keys(r.types).map((t) => EDGE_LABEL[t] ?? t).join(', ')} (${r.count})`;
    b.append(name, small);
    b.addEventListener('click', () => void select(r.other));
    li.append(b);
    ul.append(li);
  }
  note.textContent = `${rows.length} connected on the map, strongest first. Counts are real relationships between what is inside.`;
  frag.append(note, ul);
  return frag;
}

function describe(d: NodeDetail): string {
  const m = d.node.metadata ?? {};
  const bits: string[] = [TYPE_SINGULAR[d.node.type] ?? d.node.type];
  if (d.node.language) bits.push(`in ${d.node.language}`);
  if (m.exported === true) bits.push('exported');
  if (m.framework) bits.push(`${String(m.framework)} route`);
  if (m.external === true) bits.push('from outside this repository');
  if (m.entryPoint === true) bits.push('package entry point');
  if (m.parseErrors === true) bits.push('has syntax errors, so its contents may be incomplete');
  if (m.skipped) bits.push(`not analyzed: ${String(m.skipped)}`);
  if (d.view.descendants > 0) bits.push(`${d.view.descendants} things inside`);
  return bits.join(', ');
}

function clearHighlight(): void {
  rippleTimers.forEach((t) => clearTimeout(t));
  rippleTimers = [];
  impact = undefined;
}

async function select(id: string): Promise<void> {
  selected = id;
  clearHighlight();
  hulls.highlighted = expanded.has(id) ? id : undefined;
  recomputeAround();
  const d = await api<NodeDetail>(`/api/node?id=${encodeURIComponent(id)}`);
  if (selected !== id) return;
  const panel = $('detail');
  panel.hidden = false;
  panel.replaceChildren();

  const h = document.createElement('h2');
  h.textContent = (d.node.metadata?.qualified as string | undefined) ?? d.node.name;
  const kind = document.createElement('p');
  kind.className = 'kind';
  kind.textContent = describe(d);
  panel.append(h, kind);
  const ref = d.node.path ? (d.node.startLine ? `${d.node.path}:${d.node.startLine}${d.node.endLine && d.node.endLine !== d.node.startLine ? `-${d.node.endLine}` : ''}` : d.node.path) : undefined;
  if (ref) {
    const where = document.createElement('p');
    where.className = 'where';
    where.textContent = ref;
    panel.append(where);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const summary = document.createElement('p');
  summary.className = 'impact-summary';
  summary.setAttribute('role', 'status');
  const button = (label: string, run: (b: HTMLButtonElement) => void, title?: string): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', () => run(b));
    actions.append(b);
  };
  const toggleImpact = (direction: 'dependents' | 'dependencies') => (b: HTMLButtonElement): void => {
    const on = b.getAttribute('aria-pressed') === 'true';
    actions.querySelectorAll('button').forEach((x) => x.removeAttribute('aria-pressed'));
    if (on) { clearHighlight(); summary.textContent = ''; recomputeAround(); return; }
    b.setAttribute('aria-pressed', 'true');
    void showImpact(id, direction, summary);
  };
  button('Focus', () => { if (graph.hasNode(id)) centerOn(id, 0.25); else if (expanded.has(id)) { const b = hulls.bounds(id); if (b) centerAt((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, 0.2); } }, 'Zoom to it');
  button('Isolate', () => void enterFocus(id), 'Show only this and what it is directly connected to');
  if (mode === 'map') {
    button('Used by', toggleImpact('dependents'), 'Light up everything that depends on this, hop by hop');
    button('Uses', toggleImpact('dependencies'), 'Light up everything this depends on, hop by hop');
    if (d.view.childCount > 0) button(expanded.has(id) ? 'Close' : 'Open', () => void toggle(id));
  }
  if (ref) button('Copy reference', (b) => { void navigator.clipboard?.writeText(ref).then(() => { b.textContent = 'Copied'; }).catch(() => undefined); });
  panel.append(actions, summary);

  // Only folders and groups have no relations of their own. A file or function with things inside still has real ones.
  if (mode === 'map' && ['directory', 'group', 'repository'].includes(d.node.type)) panel.append(areaLinks(id));
  else panel.append(relationList('Used by', d.incoming, d.incomingTotal), relationList('Uses', d.outgoing, d.outgoingTotal));

  if (d.sessions.length) {
    const hs = document.createElement('h3');
    hs.textContent = 'Agent sessions';
    const ul = document.createElement('ul');
    ul.className = 'history';
    for (const session of d.sessions) {
      const li = document.createElement('li');
      const when = document.createElement('small');
      when.textContent = `${session.lastEventAt.slice(0, 10)} ${session.id.slice(0, 8)} `;
      li.append(when, document.createTextNode(`${session.agent} ${session.changed ? 'changed this' : 'read this'}`));
      ul.append(li);
    }
    panel.append(hs, ul);
  }
  if (d.history.length) {
    const hh = document.createElement('h3');
    hh.textContent = 'Recent changes';
    const ul = document.createElement('ul');
    ul.className = 'history';
    for (const c of d.history) {
      const li = document.createElement('li');
      const when = document.createElement('small');
      when.textContent = `${c.date} ${c.commit} `;
      li.append(when, document.createTextNode(c.subject));
      ul.append(li);
    }
    panel.append(hh, ul);
  }
}

function deselect(): void {
  selected = undefined;
  hulls.highlighted = undefined;
  clearHighlight();
  around = undefined;
  $('detail').hidden = true;
  sigma.refresh();
}

/** The nearest thing on screen for a node that may be inside a closed folder. */
async function nearestVisible(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(ids.slice(0, 500).map(async (id) => {
    if (graph.hasNode(id)) { out.set(id, id); return; }
    const { ids: chain } = await api<{ ids: string[] }>(`/api/ancestors?id=${encodeURIComponent(id)}`);
    for (let i = chain.length - 1; i >= 0; i--) {
      const a = chain[i];
      if (a && graph.hasNode(a)) { out.set(id, a); return; }
    }
  }));
  return out;
}

/** Spreads outward one dependency hop at a time, so the depth of the impact is visible rather than just its size. */
async function showImpact(id: string, direction: 'dependents' | 'dependencies', summary: HTMLElement): Promise<void> {
  const { items } = await api<{ items: Array<{ id: string; depth: number; confidence: number }> }>(`/api/impact?id=${encodeURIComponent(id)}&direction=${direction}`);
  clearHighlight();
  around = undefined;
  const mapped = await nearestVisible(items.map((i) => i.id));
  const byDepth = new Map<number, Set<string>>();
  for (const item of items) {
    const v = mapped.get(item.id);
    if (!v) continue;
    const set = byDepth.get(item.depth) ?? new Set<string>();
    set.add(v);
    byDepth.set(item.depth, set);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const lit = new Map<string, number>();
  if (selected && graph.hasNode(selected)) lit.set(selected, 0);
  impact = lit;
  const light = (depth: number): void => { for (const v of byDepth.get(depth) ?? []) if (!lit.has(v)) lit.set(v, depth); sigma.refresh(); };
  if (REDUCED_MOTION) depths.forEach(light);
  else depths.forEach((d, i) => rippleTimers.push(window.setTimeout(() => light(d), i * 260)));
  sigma.refresh();

  const direct = items.filter((i) => i.depth === 1).length;
  const unsure = items.filter((i) => i.confidence < 1).length;
  const noun = direction === 'dependents' ? 'depend on this' : 'this depends on';
  summary.textContent = items.length === 0
    ? (direction === 'dependents' ? 'Nothing in the graph depends on this.' : 'This depends on nothing else in the graph.')
    : `${items.length} things ${noun} (${direct} directly), up to ${depths[depths.length - 1]} steps away.${unsure ? ` ${unsure} are through inferred links, so may not be real dependencies.` : ''}`;
}

// ── Isolating one node and what it is directly connected to ─────────────────────────────────────────────────────
async function enterFocus(id: string): Promise<void> {
  const d = await api<NodeDetail>(`/api/node?id=${encodeURIComponent(id)}`);
  stopLayouts();
  if (mode === 'map') { savePositions(); snapshot = graph.export(); }
  mode = 'focus';
  hovered = undefined;
  $('tip').hidden = true;
  hideHint();
  clearHighlight();
  around = undefined;
  graph.clear();
  clearHover();
  hulls.set([]);
  const centerProgram = TYPE_PROGRAM[d.node.type] ?? 'circle';
  const centerColor = TYPE_COLOR[d.node.type] ?? '#8ba0b2';
  graph.addNode(id, { x: 0, y: 0, label: d.node.name, color: centerColor, borderColor: centerColor, type: centerProgram, kind: d.node.type, size: 13, cluster: '' });

  // One line per neighbour, however many ways it is connected, with the ways named. Each comes from a real relation.
  const link = new Map<string, { rel: Relation; incoming: boolean; types: Set<string>; weakest: number; exact: boolean }>();
  const gather = (list: Relation[], incoming: boolean): void => {
    for (const r of list) {
      const key = `${incoming ? 'in' : 'out'}:${r.id}`;
      const cur = link.get(key) ?? { rel: r, incoming, types: new Set<string>(), weakest: 1, exact: true };
      cur.types.add(r.edge);
      cur.weakest = Math.min(cur.weakest, r.confidence);
      if (r.resolution !== 'exact' && r.resolution !== 'resolved') cur.exact = false;
      link.set(key, cur);
    }
  };
  gather(d.incoming, true);
  gather(d.outgoing, false);
  const left = [...link.values()].filter((l) => l.incoming);
  const right = [...link.values()].filter((l) => !l.incoming);
  const place = (list: typeof left, side: -1 | 1): void => {
    const R = 110 + Math.min(300, list.length * 4);
    list.forEach((l, i) => {
      const spread = Math.min(Math.PI * 0.85, 0.12 * list.length + 0.3);
      const a = list.length === 1 ? 0 : -spread / 2 + (spread * i) / (list.length - 1);
      const r = l.rel;
      if (!graph.hasNode(r.id)) {
        const color = TYPE_COLOR[r.type] ?? '#8ba0b2';
        graph.addNode(r.id, { x: side * Math.cos(a) * R, y: Math.sin(a) * R, label: r.name, color, borderColor: color, type: TYPE_PROGRAM[r.type] ?? 'circle', kind: r.type, size: Math.max(5, (TYPE_SIZE[r.type] ?? 3.5) + 2), cluster: '' });
      }
      const [s, t] = l.incoming ? [r.id, id] : [id, r.id];
      const key = `${s}->${t}`;
      if (graph.hasEdge(key)) return;
      const dominant = [...l.types][0] ?? 'USES';
      const base = EDGE_COLOR[dominant] ?? '#8c9aa6';
      graph.addEdgeWithKey(key, s, t, { color: rgba(base, l.exact ? 0.75 : 0.35), size: 1.3, curvature: 0.2, type: 'curved', types: Object.fromEntries([...l.types].map((x) => [x, 1])), exact: l.exact });
    });
  };
  place(left, -1);
  place(right, 1);
  selected = id;
  recomputeAround();
  fit();
  window.setTimeout(() => camera.animate({ ratio: 1.5 }, { duration: 200 }), 400);
  $('focusbar').hidden = false;
  const shown = (d.incoming.length < d.incomingTotal || d.outgoing.length < d.outgoingTotal) ? `, showing ${d.incoming.length} of ${d.incomingTotal} used by and ${d.outgoing.length} of ${d.outgoingTotal} uses` : '';
  $('focuslabel').textContent = `Isolated: ${d.node.name}  (${d.incomingTotal} used by, ${d.outgoingTotal} uses${shown})`;
  await select(id);
}

async function leaveFocus(): Promise<void> {
  if (mode !== 'focus') return;
  mode = 'map';
  hovered = undefined;
  graph.clear();
  if (snapshot) graph.import(snapshot);
  snapshot = undefined;
  $('focusbar').hidden = true;
  structureChanged();
  await refreshEdges();
  fit();
  if (selected && graph.hasNode(selected)) await select(selected);
  else deselect();
}

// ── Minimap ─────────────────────────────────────────────────────────────────────────────────────────────────────
const mini = $<HTMLCanvasElement>('minimap');
let miniFrame = 0;
let miniMap: { scale: number; ox: number; oy: number } | undefined;
function scheduleMinimap(): void {
  if (miniFrame) return;
  miniFrame = requestAnimationFrame(() => { miniFrame = 0; drawMinimap(); });
}
function drawMinimap(): void {
  const ctx = mini.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const W = mini.clientWidth;
  const H = mini.clientHeight;
  if (mini.width !== Math.round(W * dpr)) { mini.width = Math.round(W * dpr); mini.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (graph.order === 0) return;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  graph.forEachNode((_id, a) => { x1 = Math.min(x1, a.x as number); y1 = Math.min(y1, a.y as number); x2 = Math.max(x2, a.x as number); y2 = Math.max(y2, a.y as number); });
  const tl = sigma.viewportToGraph({ x: 0, y: 0 });
  const br = sigma.viewportToGraph({ x: sigma.getDimensions().width, y: sigma.getDimensions().height });
  // Include the viewport, so it is still visible when panned past the edge of the graph.
  x1 = Math.min(x1, tl.x); y1 = Math.min(y1, tl.y); x2 = Math.max(x2, br.x); y2 = Math.max(y2, br.y);
  const pad = 8;
  const scale = Math.min((W - pad * 2) / Math.max(1, x2 - x1), (H - pad * 2) / Math.max(1, y2 - y1));
  const ox = (W - (x2 - x1) * scale) / 2 - x1 * scale;
  const oy = (H - (y2 - y1) * scale) / 2 - y1 * scale;
  miniMap = { scale, ox, oy };
  graph.forEachNode((_id, a) => {
    if (a.hidden) return;
    ctx.fillStyle = a.color as string;
    const s = (a.size as number) > 8 ? 3 : 1.6;
    ctx.fillRect((a.x as number) * scale + ox - s / 2, (a.y as number) * scale + oy - s / 2, s, s);
  });
  ctx.strokeStyle = 'rgba(240, 191, 98, 0.95)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(tl.x * scale + ox, tl.y * scale + oy, (br.x - tl.x) * scale, (br.y - tl.y) * scale);
}
function bindMinimap(): void {
  let dragging = false;
  const move = (ev: PointerEvent): void => {
    if (!miniMap) return;
    const r = mini.getBoundingClientRect();
    const gx = (ev.clientX - r.left - miniMap.ox) / miniMap.scale;
    const gy = (ev.clientY - r.top - miniMap.oy) / miniMap.scale;
    const f = sigma.viewportToFramedGraph(sigma.graphToViewport({ x: gx, y: gy }));
    camera.setState({ ...camera.getState(), x: f.x, y: f.y });
  };
  mini.addEventListener('pointerdown', (ev) => { dragging = true; mini.setPointerCapture(ev.pointerId); move(ev); });
  mini.addEventListener('pointermove', (ev) => { if (dragging) move(ev); });
  mini.addEventListener('pointerup', () => { dragging = false; });
}

// ── Side panel: filters, areas, search ──────────────────────────────────────────────────────────────────────────
interface FilterEntry { key: string; label: string; count?: number; color?: string; shape?: 'ring' | 'sq'; onName?: () => void }
function filterList(host: HTMLElement, entries: FilterEntry[], hidden: Set<string>, changed: () => void): void {
  host.replaceChildren();
  for (const e of entries) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !hidden.has(e.key);
    box.addEventListener('change', () => { if (box.checked) hidden.delete(e.key); else hidden.add(e.key); changed(); });
    label.append(box);
    if (e.color) {
      const swatch = document.createElement('span');
      swatch.className = `swatch${e.shape ? ` ${e.shape}` : ''}`;
      swatch.style.setProperty('--swatch', e.color);
      label.append(swatch);
    }
    const name = document.createElement('span');
    name.className = 'areas-name';
    name.textContent = e.label;
    if (e.onName) name.addEventListener('click', (ev) => { ev.preventDefault(); e.onName?.(); });
    label.append(name);
    if (e.count !== undefined) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = e.count.toLocaleString();
      label.append(count);
    }
    li.append(label);
    host.append(li);
  }
}

/** Types changed: the set of things that may appear is different, so the open folders are rebuilt in place. */
async function rebuild(): Promise<void> {
  if (mode !== 'map') return;
  stopLayouts();
  savePositions();
  const order = [...wanted].sort((a, b) => ancestorsOf(a).length - ancestorsOf(b).length);
  graph.clear();
  expanded.clear();
  say('Updating...');
  // Opening one folder can reveal another that was waiting to be opened, so go round until nothing new opens.
  for (let pass = 0; pass < 8; pass++) {
    let progressed = false;
    for (const id of order) if (!expanded.has(id) && (id === ROOT || graph.hasNode(id)) && (await expand(id, false))) progressed = true;
    if (!progressed) break;
  }
  await refreshEdges();
  await applyLayout(false);
  say('');
}

function bindSearch(): void {
  const input = $<HTMLInputElement>('search');
  const list = $<HTMLUListElement>('results');
  let items: ViewNode[] = [];
  let active = -1;
  let timer = 0;
  const render = (): void => {
    list.replaceChildren();
    list.hidden = items.length === 0 && input.value.trim() === '';
    if (input.value.trim() && items.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No matches. Search by file name, symbol, route or table.';
      list.append(li);
      return;
    }
    items.forEach((v, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.textContent = v.name;
      const small = document.createElement('small');
      small.textContent = `${TYPE_SINGULAR[v.type] ?? v.type}${v.path ? ` in ${v.path}` : ''}`;
      li.append(small);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(v); });
      list.append(li);
    });
  };
  const choose = (v: ViewNode): void => { list.hidden = true; input.blur(); void reveal(v.id); };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const q = input.value.trim();
      items = q ? (await api<{ items: ViewNode[] }>(`/api/search?q=${encodeURIComponent(q)}`)).items : [];
      active = -1;
      render();
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { const v = items[Math.max(active, 0)]; if (v) choose(v); }
    else if (e.key === 'Escape') { list.hidden = true; input.blur(); }
  });
  input.addEventListener('blur', () => { list.hidden = true; });
}

async function loadRecent(): Promise<void> {
  const { items } = await api<{ items: Array<{ path: string; date: string; subject: string }> }>('/api/recent');
  const host = $('recent');
  host.replaceChildren();
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = 'No commits yet.';
    host.append(li);
    return;
  }
  for (const c of items.slice(0, 12)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.path.split('/').pop() ?? c.path;
    b.title = `${c.path}\n${c.date}: ${c.subject}`;
    b.addEventListener('click', () => void reveal(`file:${c.path}`));
    li.append(b);
    host.append(li);
  }
}

// ── Hover tip ───────────────────────────────────────────────────────────────────────────────────────────────────
function showTip(id: string): void {
  const tip = $('tip');
  const a = graph.getNodeAttributes(id);
  const v = known.get(id);
  const p = sigma.graphToViewport({ x: a.x as number, y: a.y as number });
  tip.replaceChildren();
  const b = document.createElement('b');
  b.textContent = String(a.label).replace(/\s{2,}\d+$/, '');
  const s = document.createElement('span');
  s.textContent = `${TYPE_SINGULAR[a.kind as string] ?? a.kind}${v && v.descendants > 0 ? `, ${v.descendants} inside` : ''}`;
  tip.append(b, s);
  if (v?.path) {
    const c = document.createElement('code');
    c.textContent = `${v.path}${v.startLine ? `:${v.startLine}` : ''}`;
    tip.append(document.createElement('br'), c);
  }
  tip.hidden = false;
  const w = $('graph').clientWidth;
  tip.style.setProperty('left', `${Math.min(w - 350, Math.max(8, p.x + 14))}px`);
  tip.style.setProperty('top', `${Math.max(8, p.y + 14)}px`);
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  let overview: Overview;
  try {
    overview = await api<Overview>('/api/overview');
  } catch (err) {
    document.body.replaceChildren();
    const p = document.createElement('p');
    p.className = 'notice';
    p.textContent = `${err instanceof Error ? err.message : String(err)}`;
    document.body.append(p);
    return;
  }
  const m = overview.metadata;
  if (m) {
    document.title = `${m.repository.name}: codebase graph`;
    $('repo').textContent = m.repository.name;
    const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);
    $('stats').textContent = `${sum(m.nodes).toLocaleString()} nodes, ${sum(m.edges).toLocaleString()} relationships${m.repository.branch ? `, ${m.repository.branch}` : ''}${m.repository.commit ? ` at ${m.repository.commit.slice(0, 7)}` : ''}`;
    filterList($('types'), Object.keys(TYPE_LABEL).filter((t) => (m.nodes[t] ?? 0) > 0).map((t) => {
      const program = TYPE_PROGRAM[t];
      return { key: t, label: TYPE_LABEL[t] ?? t, count: m.nodes[t], color: TYPE_COLOR[t], ...(program === 'ring' ? { shape: 'ring' as const } : program === 'square' ? { shape: 'sq' as const } : {}) };
    }), hiddenTypes, () => void rebuild());
    filterList($('edges'), Object.keys(EDGE_LABEL).filter((t) => (m.edges[t] ?? 0) > 0).map((t) => ({ key: t, label: EDGE_LABEL[t] ?? t, count: m.edges[t], color: EDGE_COLOR[t] })), hiddenEdges, () => void refreshEdges());
  }
  bindSearch();
  bindMinimap();
  void loadRecent();

  if (overview.root) known.set(overview.root.id, overview.root);
  childCache.set(ROOT, overview.children);
  await expand(ROOT, false);
  filterList($('areas'), overview.children.items.filter((v) => isContainer(v)).map((v) => ({
    key: v.name, label: v.name, count: v.descendants, color: clusterColor(v.name), onName: () => zoomToArea(v.name),
  })), hiddenAreas, () => { sigma.refresh(); hulls.markDirty(); });
  await refreshEdges();
  await applyLayout(true);
  fit();

  sigma.on('clickNode', ({ node }) => { hideHint(); void select(node); });
  sigma.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
    preventSigmaDefault();
    if (mode === 'focus') { void enterFocus(node); return; }
    if ((known.get(node)?.childCount ?? 0) > 0) void toggle(node);
  });
  sigma.on('clickStage', ({ event }) => {
    const hit = hulls.hit(event.x, event.y);
    if (hit) { void select(hit); return; }
    deselect();
  });
  sigma.on('enterNode', ({ node }) => { hovered = node; $('graph').style.setProperty('cursor', 'pointer'); showTip(node); sigma.refresh({ skipIndexation: true }); });
  sigma.on('leaveNode', () => { hovered = undefined; $('graph').style.removeProperty('cursor'); $('tip').hidden = true; sigma.refresh({ skipIndexation: true }); });
  sigma.on('downStage', () => { hideHint(); $('tip').hidden = true; });

  $('fit').addEventListener('click', fit);
  $('zoomin').addEventListener('click', () => void camera.animatedZoom({ duration: 200 }));
  $('zoomout').addEventListener('click', () => void camera.animatedUnzoom({ duration: 200 }));
  $('level').addEventListener('click', () => void openLevel());
  $('collapse').addEventListener('click', async () => {
    if (mode === 'focus') await leaveFocus();
    // Closing a folder closes what was open inside it, so only the top level remains.
    for (const id of [...expanded]) if (id !== ROOT && ancestorsOf(id).length === 0) collapse(id);
    deselect();
    await refreshEdges();
    await applyLayout(true);
    fit();
  });
  $('unfocus').addEventListener('click', () => void leaveFocus());
  document.querySelectorAll<HTMLButtonElement>('#layouts button').forEach((b) => b.addEventListener('click', () => {
    layoutName = b.dataset.layout as LayoutName;
    document.querySelectorAll('#layouts button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    void applyLayout(true).then(fit);
  }));

  document.addEventListener('keydown', (e) => {
    const typing = document.activeElement instanceof HTMLInputElement;
    if (e.key === '/' && !typing) { e.preventDefault(); $<HTMLInputElement>('search').focus(); }
    else if (e.key === 'Escape') { if (mode === 'focus') void leaveFocus(); else deselect(); }
    else if ((e.key === 'f' || e.key === 'F') && !typing) fit();
  });
  window.addEventListener('resize', () => { hulls.markDirty(); sigma.refresh(); });
}

function hideHint(): void { $('hint').hidden = true; }

void main();

// Exposed for the browser smoke test only; read-only handles, nothing a page could use to reach the server.
(window as unknown as { __graph: unknown }).__graph = { graph, sigma, expandAll: openLevel, enterFocus, select, get mode() { return mode; } };
