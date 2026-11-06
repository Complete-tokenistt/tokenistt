/** Screens as lines of text. Pure functions of real data, so they can be tested without a terminal and never overflow. */
import { describeCost, sumCosts } from '../agents/sessions.js';
import type { DashboardData, FinopsData, FinopsRow, UsageGroup } from './data.js';
import { formatDuration } from './format.js';
import { CLI_HELP } from './commands.js';
import type { Glyphs, Tone } from './theme.js';

export interface Seg { t: string; tone?: Tone; bold?: boolean }
export interface Line { segs: Seg[]; selected?: boolean }
export interface View {
  lines: Line[];
  /** Line to keep in view. Absent: the screen scrolls freely. */
  focus?: number;
  /** How many things the cursor can select. */
  count: number;
  /** For clicking: which selectable item each line is, by line index. */
  itemAt?: Map<number, number>;
  /** Sub-tabs drawn on the first line, if any, so a click on them can be mapped. */
  tabs?: { names: readonly string[]; active: number };
}
export interface Opts { selected: number; glyphs: Glyphs; width: number; finopsTab?: number }

export const L = (t: string, tone?: Tone, bold?: boolean): Line => ({ segs: [{ t, ...(tone ? { tone } : {}), ...(bold ? { bold } : {}) }] });
export const blank = (): Line => L('');
const head = (t: string): Line => L(t, 'accent', true);
const kv = (k: string, v: string, tone?: Tone, w = 16): Line => ({ segs: [{ t: k.padEnd(w), tone: 'dim' }, { t: v, ...(tone ? { tone } : {}) }] });
const sum = (o: Record<string, number> | undefined): number => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
export const tokens = (n: number | null | undefined): string => (n === null || n === undefined ? 'unknown' : n.toLocaleString('en-US'));
export const usd = (n: number): string => `$${n.toFixed(n !== 0 && Math.abs(n) < 1 ? 4 : 2)}`;

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
    ...d.agents.map((a): Line => ({ segs: [{ t: a.name.padEnd(20), tone: 'dim' }, { t: `${a.state === 'not connected' ? g.ring : g.bullet} ${a.state}`, tone: agentTone(a.state) }] })),
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
  const itemAt = new Map<number, number>();
  d.sessions.forEach((x, i) => {
    itemAt.set(lines.length, i);
    if (i === at) focus = lines.length;
    lines.push({ selected: i === at, segs: [{ t: `${i === at ? g.prompt : ' '} ${x.id.slice(0, 8)}  ${x.agent.padEnd(12)} `, tone: i === at ? 'accent' : 'dim' }, { t: x.state.padEnd(9), tone: agentTone(x.state) }, { t: ` ${formatDuration(x.durationMs).padStart(8)}  tokens ${tokens(x.tokens?.total ?? null)}` }] });
  });
  const s = d.sessions[at];
  if (s) {
    lines.push(blank(), head(`Session ${s.id}`), kv('Branch', s.branch ?? 'unknown'), kv('Model', s.models.join(', ') || 'unknown'), kv('Cost', describeCost(s.cost), s.cost.costUsd === null ? 'warn' : undefined),
      kv('Changed', [...s.files.created, ...s.files.modified, ...s.files.deleted].slice(0, 6).join(', ') || 'nothing'),
      kv('Errors', String(s.counts.errors), s.counts.errors ? 'warn' : undefined),
      kv('Tests', `${s.counts.testsPassed} passed, ${s.counts.testsFailed} failed${s.counts.testsUnknown ? `, ${s.counts.testsUnknown} unknown` : ''}`, s.counts.testsFailed ? 'err' : undefined));
  }
  return { lines, focus, count: d.sessions.length, itemAt };
}

export function memoryView(d: DashboardData, { selected, glyphs: g }: Opts): View {
  const lines: Line[] = [head('Memory'), kv('Entries', `${d.memory.active} active, ${d.memory.stale} stale`), kv('Updated', d.memory.lastUpdated ?? 'never'), blank()];
  if (!d.memories.length) { lines.push(L('Nothing remembered yet. Run tokenistt memory update.', 'dim')); return { lines, count: 0 }; }
  const at = Math.min(selected, d.memories.length - 1);
  let focus = 0;
  const itemAt = new Map<number, number>();
  d.memories.forEach((m, i) => {
    itemAt.set(lines.length, i);
    if (i === at) focus = lines.length;
    lines.push({ selected: i === at, segs: [{ t: `${i === at ? g.prompt : ' '} ${m.status === 'stale' ? '?' : ' '} `, tone: m.status === 'stale' ? 'warn' : 'accent' }, { t: m.content.replace(/\s+/g, ' ') }] });
  });
  const m = d.memories[at];
  if (m) lines.push(blank(), head('Selected'), L(m.content.replace(/\s+/g, ' ')), L(`status: ${m.status}${m.status === 'stale' ? '  (may be out of date; see sources with tokenistt memory show)' : ''}`, 'dim'));
  return { lines, focus, count: d.memories.length, itemAt };
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

export const FINOPS_TABS = ['Overview', 'Models', 'Daily', 'Weekly', 'Sessions'] as const;

const n0 = (n: number): string => Math.round(n).toLocaleString('en-US');

interface Col { head: string; width: number; right?: boolean }
function tableLines(cols: Col[], rows: Array<{ cells: string[]; tone?: Tone }>, foot?: string[]): Line[] {
  const cell = (c: Col, t: string, last: boolean): string => {
    const cut = t.length > c.width && !last ? `${t.slice(0, c.width - 1)}~` : t;
    return last ? cut : c.right ? cut.padStart(c.width) : cut.padEnd(c.width);
  };
  const row = (cells: string[], tone?: Tone, bold?: boolean): Line => ({ segs: [{ t: cols.map((c, i) => cell(c, cells[i] ?? '', i === cols.length - 1)).join('  '), ...(tone ? { tone } : {}), ...(bold ? { bold } : {}) }] });
  const out: Line[] = [row(cols.map((c) => c.head), 'dim')];
  for (const r of rows) out.push(row(r.cells, r.tone));
  if (foot) out.push(row(foot, undefined, true));
  return out;
}

function ledgerTable(title: string, keyHead: string, rows: FinopsRow[], none: string, limit = 40): Line[] {
  const out: Line[] = [head(title)];
  if (!rows.length) return [...out, L(none, 'dim')];
  const shown = rows.slice(0, limit);
  const unpriced = rows.some((r) => r.zeroCost > 0);
  const cols: Col[] = [
    { head: keyHead, width: 24 }, { head: 'requests', width: 8, right: true }, { head: 'input', width: 12, right: true }, { head: 'output', width: 11, right: true },
    { head: 'cached', width: 12, right: true }, { head: 'cost', width: unpriced ? 10 : 12, right: true },
    ...(unpriced ? [{ head: 'unpriced', width: 8, right: true }] : []),
  ];
  const cells = (r: FinopsRow, key: string): string[] => [key, n0(r.requests), n0(r.input), n0(r.output), n0(r.cached), usd(r.costUsd), ...(unpriced ? [r.zeroCost ? n0(r.zeroCost) : ''] : [])];
  const sum = (f: (r: FinopsRow) => number): number => rows.reduce((t, r) => t + f(r), 0);
  const foot = cells({ key: '', requests: sum((r) => r.requests), input: sum((r) => r.input), output: sum((r) => r.output), cached: sum((r) => r.cached), tokens: 0, costUsd: sum((r) => r.costUsd), errors: 0, zeroCost: sum((r) => r.zeroCost), p95Ms: null }, 'total');
  out.push(...tableLines(cols, shown.map((r) => ({ cells: cells(r, r.key), ...(r.zeroCost ? { tone: 'warn' as Tone } : {}) })), foot));
  if (rows.length > limit) out.push(L(`Showing ${limit} of ${rows.length}.`, 'dim'));
  if (unpriced) out.push(L('Requests with tokens but no catalog price count as $0.00 here. They are not free: add the price to your gateway catalog.', 'warn'));
  return out;
}

function agentTable(title: string, keyHead: string, rows: UsageGroup[], none: string, limit = 40): Line[] {
  const out: Line[] = [head(title)];
  if (!rows.length) return [...out, L(none, 'dim')];
  const cols: Col[] = [
    { head: keyHead, width: 24 }, { head: 'requests', width: 8, right: true }, { head: 'input', width: 12, right: true }, { head: 'output', width: 11, right: true },
    { head: 'cache read', width: 12, right: true }, { head: 'cache write', width: 11, right: true }, { head: 'estimated cost', width: 20 },
  ];
  const cells = (r: UsageGroup, key: string): string[] => [key, n0(r.requests), n0(r.input), n0(r.output), n0(r.cacheRead), n0(r.cacheCreation), describeCost(r.cost)];
  const total = rows.reduce((t, r) => ({ ...t, requests: t.requests + r.requests, input: t.input + r.input, output: t.output + r.output, cacheRead: t.cacheRead + r.cacheRead, cacheCreation: t.cacheCreation + r.cacheCreation }), { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  const foot = ['total', n0(total.requests), n0(total.input), n0(total.output), n0(total.cacheRead), n0(total.cacheCreation), describeCost(sumCosts(rows.map((r) => r.cost)))];
  out.push(...tableLines(cols, rows.slice(0, limit).map((r) => ({ cells: cells(r, r.label), ...(r.cost.costUsd === null ? { tone: 'warn' as Tone } : {}) })), foot));
  if (rows.length > limit) out.push(L(`Showing ${limit} of ${rows.length}.`, 'dim'));
  return out;
}

const LEDGER = 'From your gateway (the ledger)';
const AGENTS = 'Coding agents on this machine (estimates: tokens x catalog prices, not your bill)';

export function finopsView(d: DashboardData, { glyphs: g, finopsTab = 0 }: Opts): View {
  const tab = Math.max(0, Math.min(FINOPS_TABS.length - 1, finopsTab));
  const f: FinopsData | undefined = d.finops;
  const lines: Line[] = [{ segs: FINOPS_TABS.flatMap((t, i) => [{ t: i ? '  ' : '' }, { t, tone: (i === tab ? 'accent' : 'dim') as Tone, bold: i === tab }]) }, L('[ and ] switch tabs, or click one', 'dim'), blank()];
  const ledgerNote = (): Line[] | null => {
    if (d.gateway.state !== 'connected') return [L(d.gateway.state === 'not configured' ? 'No gateway configured. Run tokenistt login.' : `Gateway ${d.gateway.url ?? ''} is unreachable.`, 'dim')];
    if (!f) return [L('Loading from the gateway...', 'dim')];
    if (f.state !== 'ok') return [L(f.state === 'no credentials' ? 'No management credentials.' : 'Could not read the ledger.', 'warn'), L(f.detail ?? '', 'dim')];
    return null;
  };
  const note = ledgerNote();
  const ledger = (title: string, keyHead: string, pick: (x: FinopsData) => FinopsRow[], newestFirst: boolean, limit?: number): Line[] =>
    note ? [head(title), ...note] : ledgerTable(title, keyHead, newestFirst ? pick(f as FinopsData).slice().reverse() : pick(f as FinopsData), 'No requests in this period.', limit);

  if (tab === 0) {
    lines.push(head('Gateway spend'));
    if (note) lines.push(...note);
    else if (f) {
      const t = f.total;
      lines.push(t ? kv(`Last ${f.days} days`, `${usd(t.costUsd)}  ${t.requests.toLocaleString('en-US')} requests  ${tokens(t.tokens)} tokens`) : L('No requests in this period.', 'dim'));
      if (t?.errors) lines.push(kv('Errors', String(t.errors), 'warn'));
      if (t?.zeroCost) lines.push(kv('Unpriced', `${t.zeroCost} requests had tokens but no catalog price ($0.00 means unknown)`, 'warn'));
      if (f.byDay.length) lines.push(kv('Per day', spark(f.byDay.slice(-30).map((r) => r.costUsd), g.bars)), L(`  ${f.byDay[Math.max(0, f.byDay.length - 30)]?.key.slice(0, 10)} to ${f.byDay[f.byDay.length - 1]?.key.slice(0, 10)}`, 'dim'));
      lines.push(blank(), head('Budgets'));
      if (!f.budgets.length) lines.push(L('No budgets set.', 'dim'));
      for (const b of f.budgets) lines.push({ segs: [{ t: `${b.name ?? b.scope}`.slice(0, 24).padEnd(25) }, { t: `${usd(b.capUsd)} ${b.period}`.padEnd(18), tone: 'accent' }, { t: `${b.mode}${b.active ? '' : ' (off)'}`, tone: 'dim' }] });
    }
    lines.push(blank(), head('Coding agents (estimates)'));
    for (const c of d.costs) lines.push(kv(c.agent, c.sessions ? `${c.sessions} sessions, ${c.tokens.toLocaleString('en-US')} tokens${c.unreportedSessions ? ` (+${c.unreportedSessions} unreported)` : ''}, ${describeCost(c.cost)}` : 'none', c.sessions ? undefined : 'dim'));
    const fix = d.costs.flatMap((c) => c.cost.unpricedModels ?? []);
    if (fix.length) lines.push(L(`No price for: ${[...new Set(fix)].slice(0, 6).join(', ')}. Run tokenistt models --refresh, or add them to .tokenistt/prices.json`, 'warn'));
    lines.push(L('Estimates are tokens times catalog prices, not your bill. On a subscription they are not spend at all.', 'dim'));
  } else if (tab === 1) {
    lines.push(...ledger(`${LEDGER}, last ${f?.days ?? 30} days, by model`, 'model', (x) => x.byModel, false), blank(),
      ...agentTable(`${AGENTS}, by model`, 'model', d.usage.model, 'No agent usage recorded here yet.'));
  } else if (tab === 2) {
    lines.push(...ledger(`${LEDGER}, by day (UTC), newest first`, 'day', (x) => x.byDay, true, 45), blank(),
      ...agentTable(`${AGENTS}, by day (UTC)`, 'day', d.usage.day, 'No agent usage recorded here yet.', 45));
  } else if (tab === 3) {
    lines.push(...ledger(`${LEDGER}, by week (Monday start, UTC), newest first`, 'week of', (x) => x.byWeek, true, 20), blank(),
      ...agentTable(`${AGENTS}, by week (Monday start, UTC)`, 'week of', d.usage.week, 'No agent usage recorded here yet.', 20));
  } else {
    lines.push(...agentTable(`${AGENTS}, by session, largest first`, 'session', d.usage.session, 'No agent usage recorded here yet.', 40), blank());
    lines.push(head('Agent sessions synced to your gateway (all machines, estimates)'));
    if (note) lines.push(...note);
    else if (f && f.sessions.length === 0) lines.push(L('None synced. Turn it on with tokenistt sync --enable.', 'dim'));
    else if (f) {
      lines.push(...tableLines([{ head: 'agent', width: 14 }, { head: 'started', width: 17 }, { head: 'tokens', width: 12, right: true }, { head: 'cost', width: 12, right: true }, { head: 'repository / models', width: 30 }],
        f.sessions.slice(0, 40).map((x) => ({ cells: [x.agent, x.startedAt.slice(0, 16).replace('T', ' '), x.tokens === null ? 'unknown' : n0(x.tokens), x.costUsd === null ? 'unknown' : usd(x.costUsd), `${x.repository ?? ''} ${x.models.join(', ')}`.trim()] }))));
    }
  }
  return { lines, count: lines.length, tabs: { names: FINOPS_TABS, active: tab } };
}

export function helpView(): View {
  const keys: Array<[string, string]> = [
    ['Enter', 'run what you typed'], ['Tab / Shift+Tab', 'next / previous screen (completes a /command)'], ['Ctrl+K', 'command palette'],
    ['Up / Down / PgUp / PgDn', 'select or scroll (the mouse wheel too)'], ['Home / End', 'oldest / newest'], ['[ and ]', 'FinOps tabs'], ['Esc', 'clear the prompt, or stop a running command'], ['Ctrl+L', 'clear the activity feed'], ['Ctrl+C', 'quit'],
  ];
  return {
    count: 0,
    lines: [
      head('How to use this'), L('Type a command, or a question about your code. Commands run right here and print into Activity.'),
      L('Example:  graph --open     map     impact src/app.ts     how does login work', 'dim'),
      L('Click the prompt or a tab with the mouse. Hold Shift to select and copy text.', 'dim'), blank(),
      head('Keys'), ...keys.map(([k, v]) => kv(k, v, undefined, 26)), blank(),
      head('Screens (type the name, or /name)'), L('home  agents  memory  graph  nano  finops'), blank(),
      head('Commands'), ...CLI_HELP.map(([n, d]) => kv(n, d, undefined, 26)), blank(),
      L('Add --help to any command for its options, e.g.  graph --help', 'dim'),
    ],
  };
}
