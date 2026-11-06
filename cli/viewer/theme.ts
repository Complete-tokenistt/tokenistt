/** Colours, labels and which shape each kind of thing gets. One place, so the canvas, the filters and the legend agree. */

export type ProgramKey = 'circle' | 'ring' | 'square';

export const TYPE_COLOR: Record<string, string> = {
  directory: '#6b8fa3', repository: '#6b8fa3', group: '#6b8fa3', package: '#8aa4ad', service: '#5ec8d8',
  file: '#7cb0e6', test: '#8fcf7a', documentation: '#a8b39a',
  function: '#f0bf62', method: '#e2a95a', variable: '#b2c28f', env_var: '#d6cc7e',
  class: '#bd9cf0', interface: '#8f95f0', type: '#8a86c8', component: '#f09a72',
  endpoint: '#58d6a8', table: '#e08fc6', column: '#b27da6',
};

/** Compact by default; only containers are big, because they stand for many things. */
export const TYPE_SIZE: Record<string, number> = {
  file: 4, test: 4, documentation: 3.5, function: 3, method: 3, variable: 2.5, type: 3, env_var: 3.5,
  class: 5, interface: 4.5, component: 5, endpoint: 5, table: 5.5, column: 2.5, service: 6, package: 6,
};

export const TYPE_PROGRAM: Record<string, ProgramKey> = {
  directory: 'ring', repository: 'ring', group: 'ring', package: 'ring', service: 'ring',
  class: 'square', component: 'square', endpoint: 'square', table: 'square', column: 'square',
  interface: 'ring', type: 'ring',
};

export const TYPE_LABEL: Record<string, string> = {
  directory: 'Folders', file: 'Files', function: 'Functions', method: 'Methods', component: 'Components', class: 'Classes', interface: 'Interfaces',
  type: 'Types', variable: 'Variables', endpoint: 'API routes', table: 'Database tables', column: 'Columns', package: 'Packages', env_var: 'Environment variables',
  service: 'Services', test: 'Tests', documentation: 'Docs',
};

export const TYPE_SINGULAR: Record<string, string> = {
  directory: 'Folder', repository: 'Repository', group: 'Group', file: 'File', function: 'Function', method: 'Method', component: 'Component', class: 'Class', interface: 'Interface',
  type: 'Type', variable: 'Variable', endpoint: 'API route', table: 'Database table', column: 'Column', package: 'Package', env_var: 'Environment variable', service: 'Service', test: 'Test', documentation: 'Doc',
};

export const EDGE_LABEL: Record<string, string> = {
  IMPORTS: 'Imports', CALLS: 'Calls', USES: 'Uses', EXTENDS: 'Extends', IMPLEMENTS: 'Implements', DEPENDS_ON: 'Depends on', READS_FROM: 'Reads from',
  WRITES_TO: 'Writes to', CONNECTS_TO: 'Handles', TESTS: 'Tests', MODIFIES: 'Modifies', DOCUMENTED_BY: 'Documented by',
};

export const EDGE_COLOR: Record<string, string> = {
  IMPORTS: '#5aa9e6', CALLS: '#e6b450', USES: '#8c9aa6', EXTENDS: '#b48ead', IMPLEMENTS: '#c792ea', DEPENDS_ON: '#5ec8d8', READS_FROM: '#58d6a8',
  WRITES_TO: '#ee8068', CONNECTS_TO: '#3fd1c5', TESTS: '#8fcf7a', MODIFIES: '#d6cc7e', DOCUMENTED_BY: '#8c9aa6',
};

export const BACKGROUND = '#0b1118';
export const OUT_COLOR = '#f0bf62';
export const IN_COLOR = '#58d6a8';
export const IMPACT_COLOR = '#f09a72';

const CLUSTER_PALETTE = ['#5aa9e6', '#58d6a8', '#e6b450', '#c792ea', '#ee8068', '#5ec8d8', '#e08fc6', '#8fcf7a', '#f09a72', '#8f95f0', '#d6cc7e', '#6bb7a0'];

/** The same folder always gets the same colour in a session, in the order the folders are first seen. */
const clusterColors = new Map<string, string>();
export function clusterColor(name: string): string {
  let c = clusterColors.get(name);
  if (!c) {
    c = CLUSTER_PALETTE[clusterColors.size % CLUSTER_PALETTE.length] as string;
    clusterColors.set(name, c);
  }
  return c;
}

export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Mixes a colour towards the background, so a dimmed node stays the same hue instead of going grey and flat. */
export function fade(hex: string, amount: number): string {
  const f = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const [r, g, b] = f(hex);
  const [br, bg, bb] = f(BACKGROUND);
  const m = (a: number, c: number): number => Math.round(a * (1 - amount) + c * amount);
  return `rgb(${m(r, br)}, ${m(g, bg)}, ${m(b, bb)})`;
}
