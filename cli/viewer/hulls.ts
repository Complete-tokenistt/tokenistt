/** Soft outlines behind the things that belong to one open folder, drawn on a layer under the labels. */
import type Graph from 'graphology';
import type Sigma from 'sigma';
import { convexHull, type Pt } from './geometry.js';
import { rgba } from './theme.js';

export interface HullGroup { id: string; name: string; color: string; cluster: string; depth: number; members: string[] }

interface Geo { hull: Pt[]; group: HullGroup }
interface LabelBox { id: string; x: number; y: number; w: number; h: number }

export class Hulls {
  private groups: HullGroup[] = [];
  private geo: Geo[] = [];
  private dirty = true;
  private boxes: LabelBox[] = [];
  private ctx: CanvasRenderingContext2D | null;
  highlighted: string | undefined;

  constructor(private canvas: HTMLCanvasElement, private sigma: Sigma, private graph: Graph) {
    this.ctx = canvas.getContext('2d');
  }

  set(groups: HullGroup[]): void { this.groups = groups; this.dirty = true; }
  markDirty(): void { this.dirty = true; }

  private resize(): { w: number; h: number; dpr: number } {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    return { w, h, dpr };
  }

  private rebuild(): void {
    this.geo = [];
    for (const g of this.groups) {
      const pts: Pt[] = [];
      for (const id of g.members) if (this.graph.hasNode(id)) pts.push([this.graph.getNodeAttribute(id, 'x') as number, this.graph.getNodeAttribute(id, 'y') as number]);
      if (pts.length) this.geo.push({ hull: convexHull(pts), group: g });
    }
    this.geo.sort((a, b) => a.group.depth - b.group.depth);
    this.dirty = false;
  }

  draw(visible: (g: HullGroup) => boolean = () => true): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { w, h, dpr } = this.resize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.boxes = [];
    if (this.dirty) this.rebuild();
    for (const { hull, group } of this.geo) {
      if (!visible(group) || group.members.length < 2) continue;
      const pts = hull.map(([x, y]) => { const v = this.sigma.graphToViewport({ x, y }); return [v.x, v.y] as Pt; });
      const pad = Math.max(8, 22 - group.depth * 4);
      const hot = this.highlighted === group.id;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (pts.length === 1) ctx.arc((pts[0] as Pt)[0], (pts[0] as Pt)[1], pad, 0, Math.PI * 2);
      else pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (pts.length > 2) ctx.closePath();
      ctx.fillStyle = rgba(group.color, hot ? 0.16 : 0.035);
      ctx.strokeStyle = rgba(group.color, hot ? 0.5 : 0.09);
      ctx.lineWidth = pad * 2;
      ctx.stroke();
      ctx.fill();
      // The edge of the area, as a thin line inside the soft halo.
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(group.color, hot ? 0.9 : 0.45);
      ctx.stroke();

      const xs = pts.map((p) => p[0]);
      const top = Math.min(...pts.map((p) => p[1]));
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const size = group.depth === 0 ? 13 : 11;
      ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
      const text = `${group.name}  ${group.members.length}`;
      const tw = ctx.measureText(text).width;
      const ly = top - pad - 7;
      // Skip labels on areas too small on screen to be worth naming, or that sit off screen.
      const span = Math.max(...xs) - Math.min(...xs);
      if (span < (group.depth === 0 ? 90 : 240)) continue;
      if (ly < -20 || ly > h + 20 || cx + tw / 2 < 0 || cx - tw / 2 > w) continue;
      ctx.fillStyle = 'rgba(11, 17, 24, 0.82)';
      ctx.fillRect(cx - tw / 2 - 6, ly - size - 2, tw + 12, size + 8);
      ctx.fillStyle = hot ? '#ffffff' : rgba(group.color, 0.95);
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, cx - tw / 2, ly);
      this.boxes.push({ id: group.id, x: cx - tw / 2 - 6, y: ly - size - 2, w: tw + 12, h: size + 8 });
    }
  }

  /** The folder whose label is at this point of the canvas, if any. */
  hit(x: number, y: number): string | undefined {
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i] as LabelBox;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
    }
    return undefined;
  }

  /** Bounds of one group in graph coordinates, for zooming to it. */
  bounds(id: string): { x1: number; y1: number; x2: number; y2: number } | undefined {
    const g = this.geo.find((x) => x.group.id === id);
    if (!g) return undefined;
    const xs = g.hull.map((p) => p[0]);
    const ys = g.hull.map((p) => p[1]);
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  }
}
