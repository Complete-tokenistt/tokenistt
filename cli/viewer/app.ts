/** The browser side of the graph viewer. Nothing is rendered until asked for: only open areas reach the canvas. */
import cytoscape, { type Core, type ElementDefinition, type NodeSingular } from 'cytoscape';
import fcose from 'cytoscape-fcose';

cytoscape.use(fcose);

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

const TOKEN = new URLSearchParams(location.search).get('t') ?? '';
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

const TYPE_COLOR: Record<string, string> = {
  directory: '#5d7f8c', repository: '#5d7f8c', group: '#5d7f8c', file: '#7fa6c9', function: '#e2b15c', method: '#d6a35a', component: '#e8926a',
  class: '#b7a3e0', interface: '#9c9be0', type: '#8e8cc4', variable: '#a8b58a', endpoint: '#6fcfa6', table: '#cf8fbf', column: '#a97a9e',
  package: '#8a9aa0', env_var: '#c9c07a', service: '#6fb8c7', test: '#88c070', documentation: '#a0a890',
};
const TYPE_LABEL: Record<string, string> = {
  directory: 'Folders', file: 'Files', function: 'Functions', method: 'Methods', component: 'Components', class: 'Classes', interface: 'Interfaces',
  type: 'Types', variable: 'Variables', endpoint: 'API routes', table: 'Tables', column: 'Columns', package: 'Packages', env_var: 'Environment variables',
  service: 'Services', test: 'Tests', documentation: 'Docs',
};
const TYPE_SINGULAR: Record<string, string> = {
  directory: 'Folder', repository: 'Repository', group: 'Group', file: 'File', function: 'Function', method: 'Method', component: 'Component', class: 'Class', interface: 'Interface',
  type: 'Type', variable: 'Variable', endpoint: 'API route', table: 'Table', column: 'Column', package: 'Package', env_var: 'Environment variable', service: 'Service', test: 'Test', documentation: 'Doc',
};
const EDGE_LABEL: Record<string, string> = {
  IMPORTS: 'Imports', CALLS: 'Calls', USES: 'Uses', EXTENDS: 'Extends', IMPLEMENTS: 'Implements', DEPENDS_ON: 'Depends on', READS_FROM: 'Reads from',
  WRITES_TO: 'Writes to', CONNECTS_TO: 'Handles', TESTS: 'Tests', MODIFIES: 'Modifies', DOCUMENTED_BY: 'Documented by',
};
const SHAPE: Record<string, cytoscape.Css.NodeShape> = {
  directory: 'round-rectangle', repository: 'round-rectangle', group: 'round-rectangle', file: 'ellipse', function: 'ellipse', method: 'ellipse', component: 'hexagon',
  class: 'hexagon', interface: 'hexagon', endpoint: 'diamond', table: 'barrel', package: 'tag', env_var: 'triangle', service: 'pentagon', test: 'vee',
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, { ...init, headers: { 'x-tokenistt-token': TOKEN, ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return (await res.json()) as T;
};

const hiddenTypes = new Set<string>(['column', 'variable', 'type']);
const hiddenEdges = new Set<string>(['DOCUMENTED_BY']);
const expanded = new Set<string>();
const known = new Map<string, ViewNode>();
let selected: string | undefined;

const cy: Core = cytoscape({
  container: $('graph'),
  wheelSensitivity: 0.3,
  minZoom: 0.05,
  maxZoom: 4,
  style: [
    { selector: 'node', style: {
      'background-color': 'data(color)', shape: 'data(shape)' as never, width: 'data(size)', height: 'data(size)', label: 'data(label)', color: '#d5e2df', 'font-size': 11,
      'font-family': 'Segoe UI, system-ui, sans-serif', 'text-valign': 'bottom', 'text-margin-y': 4, 'text-outline-color': '#0c1c24', 'text-outline-width': 2, 'min-zoomed-font-size': 7,
      'transition-property': 'opacity, border-width, border-color', 'transition-duration': REDUCED_MOTION ? 0 : 200,
    } },
    { selector: 'node:parent', style: {
      'background-color': '#16303c', 'background-opacity': 0.55, 'border-width': 1, 'border-color': '#264450', shape: 'round-rectangle', 'text-valign': 'top', 'text-margin-y': -4, padding: '18px', 'font-weight': 600,
    } },
    { selector: 'edge', style: {
      width: 'data(width)', 'line-color': '#4a6b78', 'target-arrow-color': '#4a6b78', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7, 'curve-style': 'bezier', opacity: 0.55,
      'line-style': 'data(lineStyle)' as never, 'transition-property': 'opacity, line-color', 'transition-duration': REDUCED_MOTION ? 0 : 200,
    } },
    { selector: '.dim', style: { opacity: 0.12 } },
    { selector: 'node.focus', style: { 'border-width': 3, 'border-color': '#e6c47a' } },
    { selector: 'edge.out', style: { 'line-color': '#e6c47a', 'target-arrow-color': '#e6c47a', opacity: 1, label: 'data(label)', 'font-size': 10, color: '#e6c47a', 'text-outline-color': '#0c1c24', 'text-outline-width': 2 } },
    { selector: 'edge.in', style: { 'line-color': '#6fcfa6', 'target-arrow-color': '#6fcfa6', opacity: 1, label: 'data(label)', 'font-size': 10, color: '#6fcfa6', 'text-outline-color': '#0c1c24', 'text-outline-width': 2 } },
    { selector: 'node.impact', style: { 'border-width': 3, 'border-color': '#e8926a', opacity: 1 } },
    { selector: 'node.recent', style: { 'border-width': 2, 'border-color': '#6fcfa6' } },
  ],
});

const nodeSize = (v: ViewNode): number => {
  if (v.childCount === 0) return 18;
  return Math.min(70, 24 + Math.sqrt(v.descendants) * 2.2);
};

function element(v: ViewNode, parent?: string): ElementDefinition {
  const label = v.childCount > 0 && !expanded.has(v.id) ? `${v.name} (${v.descendants})` : v.name;
  return { group: 'nodes', data: { id: v.id, parent, label, color: TYPE_COLOR[v.type] ?? '#7a8a90', shape: SHAPE[v.type] ?? 'ellipse', size: nodeSize(v), type: v.type } };
}

function visibleByType(v: ViewNode): boolean {
  return !hiddenTypes.has(v.type);
}

async function refreshEdges(): Promise<void> {
  const types = Object.keys(EDGE_LABEL).filter((t) => !hiddenEdges.has(t));
  const { edges } = await api<{ edges: RolledEdge[] }>('/api/subgraph', { method: 'POST', body: JSON.stringify({ visible: cy.nodes().filter((n) => !n.isParent()).map((n) => n.id()), types }) });
  cy.batch(() => {
    cy.edges().remove();
    cy.add(edges.map((e) => ({
      group: 'edges' as const,
      data: {
        id: `${e.source}->${e.target}`, source: e.source, target: e.target, width: Math.min(6, 1 + Math.log2(e.count)), lineStyle: e.exact ? 'solid' : 'dashed',
        label: Object.keys(e.types).map((t) => EDGE_LABEL[t] ?? t).join(', ') + (e.count > 1 ? ` (${e.count})` : ''),
      },
    })));
  });
}

function layout(fit = true): Promise<void> {
  return new Promise((resolve) => {
    const run = cy.layout({ name: 'fcose', animate: !REDUCED_MOTION, animationDuration: 350, randomize: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 90, fit, padding: 40, nodeDimensionsIncludeLabels: true, quality: 'default' } as cytoscape.LayoutOptions);
    run.one('layoutstop', () => { drawMinimap(); resolve(); });
    run.run();
  });
}

async function expand(id: string, relayout = true): Promise<void> {
  if (expanded.has(id)) return;
  const { items, total } = await api<{ items: ViewNode[]; total: number }>(`/api/children?id=${encodeURIComponent(id)}`);
  const shown = items.filter(visibleByType);
  if (shown.length === 0) return;
  expanded.add(id);
  const parent = id === 'dir:.' ? undefined : id;
  cy.batch(() => {
    for (const v of shown) {
      known.set(v.id, v);
      if (cy.getElementById(v.id).empty()) cy.add(element(v, parent));
    }
    const self = cy.getElementById(id);
    const view = known.get(id);
    if (self.nonempty() && view) self.data('label', total > items.length ? `${view.name} (largest ${items.length} of ${total})` : view.name);
  });
  if (relayout) {
    await refreshEdges();
    await layout(false);
  }
}

function collapse(id: string): void {
  const self = cy.getElementById(id);
  for (const d of self.descendants().toArray()) {
    expanded.delete(d.id());
    known.delete(d.id());
  }
  expanded.delete(id);
  self.descendants().remove();
  const view = known.get(id);
  if (view) self.data('label', `${view.name} (${view.descendants})`);
}

/** Opens the tree down to a node, then selects it. Used by search and recent changes. */
async function reveal(id: string): Promise<void> {
  const { ids } = await api<{ ids: string[] }>(`/api/ancestors?id=${encodeURIComponent(id)}`);
  for (const a of ids) await expand(a, false);
  const target = cy.getElementById(id);
  if (target.empty()) {
    // The node's type is filtered out; show details anyway rather than doing nothing.
    await refreshEdges();
    await layout(false);
    await select(id);
    return;
  }
  await refreshEdges();
  await layout(false);
  cy.animate({ center: { eles: target }, zoom: Math.max(cy.zoom(), 1), duration: REDUCED_MOTION ? 0 : 300 });
  await select(id);
}

function clearHighlight(): void {
  cy.elements().removeClass('dim focus in out impact');
}

function highlight(id: string): void {
  clearHighlight();
  const n = cy.getElementById(id);
  if (n.empty()) return;
  const around = n.connectedEdges();
  cy.elements().not(n).not(n.ancestors()).not(around).not(around.connectedNodes()).not(around.connectedNodes().ancestors()).addClass('dim');
  n.addClass('focus');
  around.filter((e) => e.source().id() === id).addClass('out');
  around.filter((e) => e.target().id() === id).addClass('in');
}

/** The nearest thing on screen for a node that may be inside a collapsed area. */
async function nearestVisible(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(ids.slice(0, 400).map(async (id) => {
    if (cy.getElementById(id).nonempty()) { out.set(id, id); return; }
    const { ids: chain } = await api<{ ids: string[] }>(`/api/ancestors?id=${encodeURIComponent(id)}`);
    for (let i = chain.length - 1; i >= 0; i--) {
      const a = chain[i];
      if (a && cy.getElementById(a).nonempty()) { out.set(id, a); return; }
    }
  }));
  return out;
}

let rippleTimers: number[] = [];

/** Spreads outward one dependency hop at a time, so the depth of the impact is visible rather than just its size. */
async function showImpact(id: string, direction: 'dependents' | 'dependencies', summary: HTMLElement): Promise<void> {
  const { items } = await api<{ items: Array<{ id: string; depth: number; confidence: number }> }>(`/api/impact?id=${encodeURIComponent(id)}&direction=${direction}`);
  rippleTimers.forEach((t) => clearTimeout(t));
  rippleTimers = [];
  cy.elements().removeClass('in out impact').addClass('dim');
  const self = cy.getElementById(id);
  self.removeClass('dim').addClass('focus');
  self.ancestors().removeClass('dim');

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
  // Bring everything affected into view, or most of the ripple would happen off-screen.
  let reach = cy.collection().union(self);
  for (const set of byDepth.values()) for (const v of set) reach = reach.union(cy.getElementById(v));
  if (reach.length > 1) cy.animate({ fit: { eles: reach, padding: 60 }, duration: REDUCED_MOTION ? 0 : 300 });
  const light = (depth: number) => {
    for (const v of byDepth.get(depth) ?? []) {
      const n = cy.getElementById(v) as NodeSingular;
      n.removeClass('dim').addClass('impact');
      n.ancestors().removeClass('dim');
    }
  };
  if (REDUCED_MOTION) depths.forEach(light);
  else depths.forEach((d, i) => rippleTimers.push(window.setTimeout(() => light(d), i * 260)));

  const direct = items.filter((i) => i.depth === 1).length;
  const unsure = items.filter((i) => i.confidence < 1).length;
  const noun = direction === 'dependents' ? 'depend on this' : 'this depends on';
  summary.textContent = items.length === 0
    ? (direction === 'dependents' ? 'Nothing in the graph depends on this.' : 'This depends on nothing else in the graph.')
    : `${items.length} things ${noun} (${direct} directly), up to ${depths[depths.length - 1]} steps away.${unsure ? ` ${unsure} are through inferred links, so may not be real dependencies.` : ''}`;
}

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
    small.textContent = `${EDGE_LABEL[r.edge] ?? r.edge}${inferred ? `, inferred (${Math.round(r.confidence * 100)}%)` : ''}${r.line ? `, line ${r.line}` : ''}`;
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

async function select(id: string): Promise<void> {
  selected = id;
  highlight(id);
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
  if (d.node.path) {
    const where = document.createElement('p');
    where.className = 'where';
    where.textContent = d.node.startLine ? `${d.node.path}:${d.node.startLine}${d.node.endLine && d.node.endLine !== d.node.startLine ? `-${d.node.endLine}` : ''}` : d.node.path;
    panel.append(where);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const summary = document.createElement('p');
  summary.className = 'impact-summary';
  summary.setAttribute('role', 'status');
  const button = (label: string, run: (b: HTMLButtonElement) => void): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => run(b));
    actions.append(b);
  };
  const toggleImpact = (direction: 'dependents' | 'dependencies') => (b: HTMLButtonElement): void => {
    const on = b.getAttribute('aria-pressed') === 'true';
    actions.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    if (on) {
      rippleTimers.forEach((t) => clearTimeout(t));
      summary.textContent = '';
      highlight(id);
      return;
    }
    b.setAttribute('aria-pressed', 'true');
    void showImpact(id, direction, summary);
  };
  button('Show what depends on this', toggleImpact('dependents'));
  button('Show what this depends on', toggleImpact('dependencies'));
  if (d.view.childCount > 0) {
    if (expanded.has(id)) button('Close', () => { collapse(id); void refreshEdges().then(() => layout(false)); });
    else button('Open', () => void expand(id));
  }
  panel.append(actions, summary);

  panel.append(relationList('Used by', d.incoming, d.incomingTotal), relationList('Uses', d.outgoing, d.outgoingTotal));

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
  rippleTimers.forEach((t) => clearTimeout(t));
  clearHighlight();
  $('detail').hidden = true;
}

function drawMinimap(): void {
  const c = $<HTMLCanvasElement>('minimap');
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const bb = cy.elements().boundingBox();
  ctx.clearRect(0, 0, c.width, c.height);
  if (!Number.isFinite(bb.w) || bb.w === 0) return;
  const scale = Math.min(c.width / bb.w, c.height / bb.h) * 0.92;
  const ox = (c.width - bb.w * scale) / 2 - bb.x1 * scale;
  const oy = (c.height - bb.h * scale) / 2 - bb.y1 * scale;
  cy.nodes().forEach((n) => {
    if (n.isParent()) return;
    const p = n.position();
    ctx.fillStyle = (n.data('color') as string) ?? '#7a8a90';
    ctx.fillRect(p.x * scale + ox - 1.5, p.y * scale + oy - 1.5, 3, 3);
  });
  const ext = cy.extent();
  ctx.strokeStyle = '#e6c47a';
  ctx.strokeRect(ext.x1 * scale + ox, ext.y1 * scale + oy, ext.w * scale, ext.h * scale);
  c.onclick = (ev) => {
    const r = c.getBoundingClientRect();
    const x = ((ev.clientX - r.left) * (c.width / r.width) - ox) / scale;
    const y = ((ev.clientY - r.top) * (c.height / r.height) - oy) / scale;
    cy.pan({ x: cy.width() / 2 - x * cy.zoom(), y: cy.height() / 2 - y * cy.zoom() });
  };
}

function filterList(host: HTMLElement, entries: Array<{ key: string; label: string; count?: number; color?: string }>, hidden: Set<string>, changed: () => void): void {
  host.replaceChildren();
  for (const e of entries) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !hidden.has(e.key);
    box.addEventListener('change', () => {
      if (box.checked) hidden.delete(e.key);
      else hidden.add(e.key);
      changed();
    });
    label.append(box);
    if (e.color) {
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.setProperty('--swatch', e.color);
      label.append(swatch);
    }
    label.append(document.createTextNode(e.label));
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

/** Re-applies type filters: hides what is on screen and re-opens areas so newly allowed types appear. */
async function applyTypeFilter(): Promise<void> {
  const reopen = [...expanded];
  cy.nodes().forEach((n) => {
    const hide = hiddenTypes.has(n.data('type') as string);
    n.style('display', hide ? 'none' : 'element');
  });
  expanded.clear();
  for (const id of reopen) await expand(id, false);
  await refreshEdges();
  await layout(false);
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
  const choose = (v: ViewNode): void => {
    list.hidden = true;
    input.blur();
    void reveal(v.id);
  };
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
    else if (e.key === 'Escape') { list.hidden = true; }
  });
  input.addEventListener('blur', () => { list.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
    else if (e.key === 'Escape') deselect();
  });
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

async function main(): Promise<void> {
  let overview: Overview;
  try {
    overview = await api<Overview>('/api/overview');
  } catch (err) {
    document.body.innerHTML = '';
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
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    $('stats').textContent = `${sum(m.nodes).toLocaleString()} nodes, ${sum(m.edges).toLocaleString()} relationships${m.repository.branch ? `, ${m.repository.branch}` : ''}${m.repository.commit ? ` at ${m.repository.commit.slice(0, 7)}` : ''}`;
    filterList($('types'), Object.keys(TYPE_LABEL).filter((t) => (m.nodes[t] ?? 0) > 0).map((t) => ({ key: t, label: TYPE_LABEL[t] ?? t, count: m.nodes[t], color: TYPE_COLOR[t] })), hiddenTypes, () => void applyTypeFilter());
    filterList($('edges'), Object.keys(EDGE_LABEL).filter((t) => (m.edges[t] ?? 0) > 0).map((t) => ({ key: t, label: EDGE_LABEL[t] ?? t, count: m.edges[t] })), hiddenEdges, () => void refreshEdges());
  }
  bindSearch();
  void loadRecent();

  if (overview.root) known.set(overview.root.id, overview.root);
  await expand('dir:.', false);
  await refreshEdges();
  await layout(true);

  cy.on('tap', 'node', (e) => void select((e.target as NodeSingular).id()));
  cy.on('tap', (e) => { if (e.target === cy) deselect(); });
  cy.on('dbltap', 'node', (e) => {
    const n = e.target as NodeSingular;
    $('hint').hidden = true;
    const id = n.id();
    if (expanded.has(id)) { collapse(id); void refreshEdges().then(() => layout(false)); }
    else void expand(id);
  });
  cy.on('viewport', drawMinimap);
  $('fit').addEventListener('click', () => cy.animate({ fit: { eles: cy.elements(), padding: 40 }, duration: REDUCED_MOTION ? 0 : 250 }));
  $('collapse').addEventListener('click', () => {
    for (const id of [...expanded]) if (id !== 'dir:.') collapse(id);
    deselect();
    void refreshEdges().then(() => layout(true));
  });
}

void main();
