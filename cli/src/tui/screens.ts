/** Screens as lines of text. Pure functions of real data, so they can be tested without a terminal and never overflow. */
import type { DashboardData, FinopsData } from './data.js';
import { formatDuration } from './format.js';
import type { Glyphs, Tone } from './theme.js';

export interface Seg { t: string; tone?: Tone; bold?: boolean }
export interface Line { segs: Seg[]; selected?: boolean }
export interface View { lines: Line[]; /** Line to keep in view. Absent: the screen scrolls freely. */ focus?: number; /** How many things the cursor can select. */ count: number }
export interface Opts { selected: number; glyphs: Glyphs; width: number }

export const L = (t: string, tone?: Tone, bold?: boolean): Line => ({ segs: [{ t, ...(tone ? { tone } : {}), ...(bold ? { bold } : {}) }] });
export const blank = (): Line => L('');
const head = (t: string): Line => L(t, 'accent', true);
const kv = (k: string, v: string, tone?: Tone): Line => ({ segs: [{ t: k.padEnd(16), tone: 'dim' }, { t: v, ...(tone ? { tone } : {}) }] });
const sum = (o: Record<string, number> | undefined): number => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
export const tokens = (n: number | null | undefined): string => (n === null || n === undefined ? 'unknown' : n.toLocaleString('en-US'));
export const usd = (n: number): string => `$${n.toFixed(n !== 0 && Math.abs(n) < 1 ? 4 : 2)}`;
const est = (n: number | null): string => (n === null ? 'unknown' : `~${usd(n)} estimated`);

export function agentTone(state: string): Tone { return state === 'active' ? 'ok' : state === 'idle' || state === 'connected' ? 'warn' : 'dim'; }

/** Status column of the home screen. */
export function homeSummary(d: DashboardData, g: Glyphs): Line[] {
  const active = d.sessions.filter((s) => s.state === 'active').length;
  return [
    head('Project'),
    kv('Repository', d.project.name),
    kv('Branch', d.project.branch ?? 'none'),
    kv('Commit', d.project.commit ? `${d.project.commit} ${d.project.subject ?? ''}`.trim() : 'none yet'),
    blank(), head('Agents'),
    ...d.agents.map((a): Line => ({ segs: [{ t: a.name.padEnd(16), tone: 'dim' }, { t: `${a.state === 'not connected' ? g.ring : g.bullet} ${a.state}`, tone: agentTone(a.state) }] })),
    blank(), head('Knowledge'),
    kv('Graph', d.graph ? `${sum(d.graph.nodes)} nodes, ${d.graph.files.total} files` : 'not indexed', d.graph ? undefined : 'warn'),
    kv('Memory', `${d.memory.active} active, ${d.memory.stale} stale`),
    kv('Sessions', `${d.sessions.length} recorded, ${active} active`),
    blank(), head('Gateway'),
    kv('State', `${d.gateway.state}${d.gateway.url ? ` (${d.gateway.url})` : ''}`, d.gateway.state === 'connected' ? 'ok' : d.gateway.state === 'unreachable' ? 'err' : 'dim'),
    kv('Sync', d.project.syncEnabled ? 'on' : 'off'),
  ];
}

export function agentsView(d: DashboardData, { selected, glyphs: g }: Opts): View {
  const lines: Line[] = [head('Agents')];
  for (const a of d.agents) {
    lines.push({ segs: [{ t: `${a.state === 'not connected' ? g.ring : g.bullet} `, tone: agentTone(a.state) }, { t: a.name.padEnd(14) }, { t: a.state.padEnd(14), tone: agentTone(a.state) }, { t: `${a.installed ? 'installed' : 'not found'}, ${a.verification === 'live' ? 'checked against the real agent' : 'from docs only'}`, tone: 'dim' }] });
    if (!a.connected) lines.push(L(`    connect with: tokenistt agents connect ${a.id}`, 'dim'));
  }
  lines.push(blank(), head('Sessions'));
  if (!d.sessions.length) { lines.push(L('No sessions recorded yet. Connect an agent with tokenistt agents connect.', 'dim')); return { lines, count: 0 }; }
  const at = Math.min(selected, d.sessions.length - 1);
  let focus = 0;
  d.sessions.forEach((x, i) => {
    if (i === at) focus = lines.length;
    lines.push({ selected: i === at, segs: [{ t: `${i === at ? g.prompt : ' '} ${x.id.slice(0, 8)}  ${x.agent.padEnd(12)} `, tone: i === at ? 'accent' : 'dim' }, { t: x.state.padEnd(9), tone: agentTone(x.state) }, { t: ` ${formatDuration(x.durationMs).padStart(8)}  tokens ${tokens(x.tokens?.total ?? null)}` }] });
  });
  const s = d.sessions[at];
  if (s) {
    lines.push(blank(), head(`Session ${s.id}`), kv('Branch', s.branch ?? 'unknown'), kv('Model', s.models.join(', ') || 'unknown'), kv('Cost', est(s.cost.costUsd)),
      kv('Changed', [...s.files.created, ...s.files.modified, ...s.files.deleted].slice(0, 6).join(', ') || 'nothing'),
      kv('Errors', String(s.counts.errors), s.counts.errors ? 'warn' : undefined),
      kv('Tests', `${s.counts.testsPassed} passed, ${s.counts.testsFailed} failed${s.counts.testsUnknown ? `, ${s.counts.testsUnknown} unknown` : ''}`, s.counts.testsFailed ? 'err' : undefined));
  }
  return { lines, focus, count: d.sessions.length };
}

export function memoryView(d: DashboardData, { selected, glyphs: g }: Opts): View {
  const lines: Line[] = [head('Memory'), kv('Entries', `${d.memory.active} active, ${d.memory.stale} stale`), kv('Updated', d.memory.lastUpdated ?? 'never'), blank()];
  if (!d.memories.length) { lines.push(L('Nothing remembered yet. Run tokenistt memory update.', 'dim')); return { lines, count: 0 }; }
  const at = Math.min(selected, d.memories.length - 1);
  let focus = 0;
  d.memories.forEach((m, i) => {
    if (i === at) focus = lines.length;
    lines.push({ selected: i === at, segs: [{ t: `${i === at ? g.prompt : ' '} ${m.status === 'stale' ? '?' : ' '} `, tone: m.status === 'stale' ? 'warn' : 'accent' }, { t: m.content.replace(/\s+/g, ' ') }] });
  });
  const m = d.memories[at];
  if (m) lines.push(blank(), head('Selected'), L(m.content.replace(/\s+/g, ' ')), L(`status: ${m.status}${m.status === 'stale' ? '  (may be out of date; see sources with tokenistt memory show)' : ''}`, 'dim'));
  return { lines, focus, count: d.memories.length };
}

export function graphView(d: DashboardData): View {
  if (!d.graph) return { lines: [head('Knowledge graph'), L('Not indexed yet. Run tokenistt map.', 'dim')], count: 0 };
  const lines: Line[] = [head('Knowledge graph'), kv('Files', String(d.graph.files.total)), kv('Nodes', String(sum(d.graph.nodes))), kv('Relationships', String(sum(d.graph.edges))), kv('Updated', d.graph.generatedAt),
    kv('Languages', Object.entries(d.graph.languages).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'), blank(), head('Node types'),
    ...Object.entries(d.graph.nodes).map(([k, v]) => kv(k, String(v))), blank(), head('Largest areas'),
    ...d.largest.map((a) => kv(String(a.nodes), a.name)), blank(), head('Most depended on'),
    ...d.mostUsed.map((a) => kv(String(a.dependents), `${a.name}${a.path ? `  ${a.path}` : ''}`)), blank(), L('Explore all of it with tokenistt graph --open.', 'dim')];
  return { lines, count: lines.length };
}

export function nanoView(): View {
  return { lines: [head('Nano'), L('Nano is not built yet.'), L('Nothing is measured or shown on this screen.', 'dim')], count: 0 };
}

function spark(values: number[], bars: string): string {
  const max = Math.max(...values, 0);
  if (!max) return bars[0]!.repeat(values.length);
  return values.map((v) => bars[Math.min(bars.length - 1, Math.floor((v / max) * (bars.length - 1)))]).join('');
}

function bar(share: number, w: number, g: Glyphs): string {
  const n = Math.max(0, Math.min(w, Math.round(share * w)));
  return (g.border === 'round' ? '█' : '#').repeat(n) + ' '.repeat(w - n);
}

export function finopsView(d: DashboardData, { glyphs: g }: Opts): View {
  const lines: Line[] = [head('Gateway spend')];
  const f: FinopsData | undefined = d.finops;
  if (d.gateway.state !== 'connected') {
    lines.push(L(d.gateway.state === 'not configured' ? 'No gateway configured. Run tokenistt login.' : `Gateway ${d.gateway.url ?? ''} is unreachable.`, 'dim'));
  } else if (!f) lines.push(L('Loading spend from the gateway...', 'dim'));
  else if (f.state !== 'ok') lines.push(L(f.state === 'no credentials' ? 'No management credentials.' : 'Could not read spend.', 'warn'), L(f.detail ?? '', 'dim'));
  else {
    const t = f.total;
    lines.push(t ? kv(`Last ${f.days} days`, `${usd(t.costUsd)}  ${t.requests.toLocaleString('en-US')} requests  ${tokens(t.tokens)} tokens`) : L('No requests in this period.', 'dim'));
    if (t?.errors) lines.push(kv('Errors', String(t.errors), 'warn'));
    if (t?.zeroCost) lines.push(kv('Unpriced', `${t.zeroCost} requests had tokens but no catalog price ($0.00 means unknown)`, 'warn'));
    if (f.byDay.length) lines.push(kv('Per day', spark(f.byDay.map((r) => r.costUsd), g.bars)), L(`  ${f.byDay[0]?.key.slice(0, 10)} to ${f.byDay[f.byDay.length - 1]?.key.slice(0, 10)}`, 'dim'));
    lines.push(blank(), head('By model'));
    const top = Math.max(...f.byModel.map((r) => r.costUsd), 0);
    if (!f.byModel.length) lines.push(L('none', 'dim'));
    for (const r of f.byModel) lines.push({ segs: [{ t: r.key.slice(0, 28).padEnd(29) }, { t: usd(r.costUsd).padStart(10), tone: 'accent' }, { t: `  ${bar(top ? r.costUsd / top : 0, 12, g)}`, tone: 'dim' }, { t: `  ${r.requests} req${r.p95Ms != null ? `  p95 ${r.p95Ms}ms` : ''}`, tone: 'dim' }] });
    lines.push(blank(), head('Budgets'));
    if (!f.budgets.length) lines.push(L('No budgets set.', 'dim'));
    for (const b of f.budgets) lines.push({ segs: [{ t: `${b.name ?? b.scope}`.slice(0, 24).padEnd(25) }, { t: `${usd(b.capUsd)} ${b.period}`.padEnd(18), tone: 'accent' }, { t: `${b.mode}${b.active ? '' : ' (off)'}`, tone: 'dim' }] });
  }
  lines.push(blank(), head('Local agents (estimates)'));
  for (const c of d.costs) lines.push(kv(c.agent, c.sessions ? `${c.sessions} sessions, tokens ${tokens(c.tokens)}, ${est(c.costUsd)}` : 'none', c.sessions ? undefined : 'dim'));
  lines.push(L('Estimates are tokens times catalog prices, not your bill. On a subscription they are not spend at all.', 'dim'));
  return { lines, count: lines.length };
}
