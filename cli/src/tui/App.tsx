/** The terminal application: screens, a persistent prompt, a command palette and a streaming activity feed. It only
 * displays what it is given, so it can be tested with plain data and no terminal. */
import { Box, Text, useApp, useInput, useStdout, type Key } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SCREENS, matching, parse, type Screen } from './commands.js';
import type { DashboardData } from './data.js';
import { agentsView, finopsView, graphView, helpView, homeSummary, memoryView, nanoView, type Line, type View } from './screens.js';
import { ASCII, UNICODE, color, toneColor, type Glyphs, type Tone } from './theme.js';

export { SCREENS };
export type { Screen };

const MAX_FEED = 400;
interface FeedItem { id: number; text: string; tone: Tone }

export interface AppProps {
  data: DashboardData;
  motion: boolean;
  initialScreen?: Screen;
  /** Fetches fresh data; absent in tests that want a fixed screen. */
  reload?: () => Promise<DashboardData>;
  reloadMs?: number;
  /** Answers plain text typed at the prompt. */
  search?: (text: string) => string[];
  unicode?: boolean;
  /** Runs a real tokenistt command and reports its output as it arrives. Absent in tests that don't need it. */
  exec?: (args: string[], onLine: (line: string) => void) => { done: Promise<number | null>; stop: () => void };
}

function Segs({ line }: { line: Line }): ReactNode {
  return (
    <Text wrap="truncate-end" {...(line.selected ? { backgroundColor: color.accent, color: 'black' } : {})}>
      {line.segs.map((s, i) => <Text key={i} bold={s.bold} dimColor={s.tone === 'dim' && !line.selected} color={line.selected ? undefined : toneColor(s.tone)}>{s.t || ' '}</Text>)}
    </Text>
  );
}

/** Shows `height` lines of a view. Selection views keep the focused line centred; others scroll by `cursor`. */
function windowed(view: View, cursor: number, height: number): { shown: Line[]; top: number } {
  const n = view.lines.length;
  const max = Math.max(0, n - height);
  const top = view.focus !== undefined ? Math.min(max, Math.max(0, view.focus - Math.floor(height / 2))) : Math.min(max, Math.max(0, cursor));
  return { shown: view.lines.slice(top, top + height), top };
}

function Panel({ title, width, height, children, focused, g }: { title?: string; width?: number | string; height: number; children: ReactNode; focused?: boolean; g: Glyphs }): ReactNode {
  return (
    <Box flexDirection="column" borderStyle={g.border === 'round' ? 'round' : 'classic'} borderColor={focused ? color.accent : color.dim} paddingX={1} width={width} height={height} overflow="hidden" flexShrink={0}>
      {title ? <Text bold>{title}</Text> : null}
      {children}
    </Box>
  );
}

function Palette({ query, sel, g, width, max }: { query: string; sel: number; g: Glyphs; width: number; max: number }): ReactNode {
  const items = matching(query).slice(0, max);
  return (
    <Box flexDirection="column" borderStyle={g.border === 'round' ? 'round' : 'classic'} borderColor={color.accent} paddingX={1} width={Math.min(64, width)}>
      <Text><Text color={color.accent}>{g.prompt} </Text>{query}<Text inverse> </Text></Text>
      {items.length ? items.map((c, i) => (
        <Text key={c.name} wrap="truncate-end" {...(i === sel ? { backgroundColor: color.accent, color: 'black' } : {})}>{`/${c.name}${c.arg ? ` ${c.arg}` : ''}`.padEnd(18)}<Text dimColor={i !== sel}>{c.hint}</Text></Text>
      )) : <Text dimColor>No matching command.</Text>}
    </Box>
  );
}

export function App({ data, motion, initialScreen = 'Home', reload, reloadMs = 2000, search, unicode = true, exec }: AppProps): ReactNode {
  const g = unicode ? UNICODE : ASCII;
  const [d, setD] = useState(data);
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [cursor, setCursor] = useState(0);
  const [input, setInputState] = useState('');
  const [pos, setPosState] = useState(0);
  // Keys can arrive faster than React renders, so the live text lives in refs and state only mirrors it for drawing.
  const inputRef = useRef('');
  const posRef = useRef(0);
  const setInput = (v: string): void => { inputRef.current = v; setInputState(v); };
  const setPos = (v: number): void => { posRef.current = v; setPosState(v); };
  const [palette, setPaletteState] = useState<{ query: string; sel: number } | null>(null);
  const paletteRef = useRef<{ query: string; sel: number } | null>(null);
  const setPalette = (v: { query: string; sel: number } | null): void => { paletteRef.current = v; setPaletteState(v); };
  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpenState] = useState(false);
  const helpOpenRef = useRef(false);
  const setHelpOpen = (v: boolean): void => { helpOpenRef.current = v; setHelpOpenState(v); };
  const [job, setJob] = useState<{ label: string; stop: () => void } | null>(null);
  const jobRef = useRef<{ label: string; stop: () => void } | null>(null);
  const [frame, setFrame] = useState(0);
  const [feed, setFeed] = useState<FeedItem[]>(() => initialFeed(data));
  const queue = useRef<Array<{ text: string; tone: Tone }>>([]);
  const nextId = useRef(1000);
  const prev = useRef(data);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });

  useEffect(() => {
    const onResize = (): void => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  /** Lines appear one at a time, like output being written, when motion is allowed; at once otherwise. */
  const push = useCallback((lines: Array<{ text: string; tone?: Tone }>) => {
    const items = lines.map((l) => ({ text: l.text, tone: l.tone ?? 'normal' }));
    if (!motion) {
      setFeed((f) => [...f, ...items.map((i) => ({ ...i, id: nextId.current++ }))].slice(-MAX_FEED));
      return;
    }
    queue.current.push(...items);
    setBusy(true);
  }, [motion]);

  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % g.spinner.length);
      const take = queue.current.splice(0, Math.max(1, Math.ceil(queue.current.length / 8)));
      if (take.length) setFeed((f) => [...f, ...take.map((n) => ({ ...n, id: nextId.current++ }))].slice(-MAX_FEED));
      if (!queue.current.length) setBusy(false);
    }, 45);
    return () => clearInterval(timer);
  }, [busy, g.spinner.length]);

  const refresh = useCallback(async () => {
    if (!reload) return;
    try {
      const next = await reload();
      const notes = changes(prev.current, next);
      prev.current = next;
      setD(next);
      if (notes.length) push(notes);
    } catch { /* keep showing the last good data */ }
  }, [reload, push]);

  useEffect(() => {
    if (!reload) return undefined;
    const timer = setInterval(() => { void refresh(); }, reloadMs);
    return () => clearInterval(timer);
  }, [reload, reloadMs, refresh]);

  const go = useCallback((s: Screen) => { setScreen(s); setCursor(0); }, []);

  const run = useCallback((text: string) => {
    const a = parse(text);
    if (a.kind === 'none') return;
    if (a.kind !== 'screen' && a.kind !== 'clear') push([{ text: `${g.prompt} ${text.trim()}`, tone: 'accent' }]);
    switch (a.kind) {
      case 'screen': go(a.screen); break;
      case 'quit': exit(); break;
      case 'clear': queue.current = []; setFeed([]); break;
      case 'help': setHelpOpen(true); setCursor(0); break;
      case 'terminal': push([{ text: `${a.command} needs a terminal of its own. Quit (Ctrl+C) and run: tokenistt ${a.line}`, tone: 'warn' }]); go('Home'); break;
      case 'suggest': push([{ text: `"${a.typed}" is not a command. Did you mean "${a.suggestion}"? It is in the prompt, press Enter to run it.`, tone: 'warn' }]); setInput(a.suggestion); setPos(a.suggestion.length); go('Home'); break;
      case 'cli': {
        go('Home');
        if (!exec) { push([{ text: 'Commands cannot run from here.', tone: 'warn' }]); break; }
        if (jobRef.current) { push([{ text: `Still running "${jobRef.current.label}". Press Esc to stop it first.`, tone: 'warn' }]); break; }
        const label = a.args.join(' ');
        const h = exec(a.args, (line) => push([{ text: line }]));
        const mine = { label, stop: h.stop };
        jobRef.current = mine;
        setJob(mine);
        void h.done.then((code) => {
          if (jobRef.current === mine) { jobRef.current = null; setJob(null); }
          push([{ text: code === 0 ? 'done' : code === null ? 'stopped' : `exited with code ${code}`, tone: code === 0 || code === null ? 'dim' : 'warn' }]);
        });
        break;
      }
      case 'refresh': push([{ text: 'Reloading...', tone: 'dim' }]); void refresh(); break;
      case 'unknown': push([{ text: `Unknown command: ${a.text}. Try /help.`, tone: 'warn' }]); go('Home'); break;
      case 'search': {
        const hits = search ? search(a.query) : [];
        push(hits.length ? hits.map((t) => ({ text: t })) : [{ text: `Nothing found for "${a.query}".`, tone: 'dim' as const }]);
        go('Home');
        break;
      }
    }
  }, [push, g.prompt, go, exit, refresh, search]);

  // Ink re-subscribes whenever the handler changes, and a key arriving in that gap is lost. A stable function avoids it.
  const handler = useRef<(ch: string, key: Key) => void>(() => undefined);
  handler.current = (ch, key) => {
    const input = inputRef.current;
    const pos = posRef.current;
    const palette = paletteRef.current;
    if (key.ctrl && ch === 'k') { setPalette(palette ? null : { query: '', sel: 0 }); return; }
    if (palette) {
      const items = matching(palette.query).slice(0, 8);
      if (key.escape) setPalette(null);
      else if (key.return) {
        const c = items[palette.sel];
        setPalette(null);
        if (c) { if (c.arg) { setInput(`/${c.name} `); setPos(c.name.length + 2); } else run(`/${c.name}`); }
      } else if (key.upArrow) setPalette({ ...palette, sel: Math.max(0, palette.sel - 1) });
      else if (key.downArrow) setPalette({ ...palette, sel: Math.min(items.length - 1, palette.sel + 1) });
      else if (key.backspace || key.delete) setPalette({ query: palette.query.slice(0, -1), sel: 0 });
      else if (ch && !key.ctrl && !key.meta && !key.tab) setPalette({ query: palette.query + ch, sel: 0 });
      return;
    }
    if (key.ctrl && ch === 'c') { jobRef.current?.stop(); exit(); return; }
    if (helpOpenRef.current) {
      if (key.escape || key.return) { setHelpOpen(false); setCursor(0); }
      else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => c + 1);
      else if (key.pageUp) setCursor((c) => Math.max(0, c - 10));
      else if (key.pageDown) setCursor((c) => c + 10);
      return;
    }
    if (key.ctrl && ch === 'd' && !input) { exit(); return; }
    if (key.ctrl && ch === 'l') { queue.current = []; setFeed([]); return; }
    if (key.ctrl && ch === 'u') { setInput(input.slice(pos)); setPos(0); return; }
    if (key.tab) {
      if (input.startsWith('/') && !key.shift) {
        const m = matching(input)[0];
        if (m) { const t = `/${m.name}${m.arg ? ' ' : ''}`; setInput(t); setPos(t.length); }
        return;
      }
      const i = SCREENS.indexOf(screen);
      go(SCREENS[(i + (key.shift ? -1 : 1) + SCREENS.length) % SCREENS.length]!);
      return;
    }
    if (key.return) { const t = input; setInput(''); setPos(0); run(t); return; }
    if (key.escape) {
      if (!input && jobRef.current) jobRef.current.stop();
      setInput(''); setPos(0);
      return;
    }
    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => c + 1); return; }
    if (key.pageUp) { setCursor((c) => Math.max(0, c - 10)); return; }
    if (key.pageDown) { setCursor((c) => c + 10); return; }
    if (key.leftArrow) { setPos(Math.max(0, pos - 1)); return; }
    if (key.rightArrow) { setPos(Math.min(input.length, pos + 1)); return; }
    if (key.backspace || key.delete) {
      if (pos > 0) { setInput(input.slice(0, pos - 1) + input.slice(pos)); setPos(pos - 1); }
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      const clean = ch.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
      if (clean) { setInput(input.slice(0, pos) + clean + input.slice(pos)); setPos(pos + clean.length); }
    }
  };
  const stable = useCallback((ch: string, key: Key) => handler.current(ch, key), []);
  useInput(stable);

  const { columns, rows } = size;
  const wide = columns >= 100;
  const bodyHeight = Math.max(5, rows - 1 - 2 - 3 - 1);
  const innerH = Math.max(1, bodyHeight - 3);
  const viewH = innerH + 1;

  // Views clamp the cursor to what exists, so scrolling past the end is harmless.
  const view: View | null = useMemo(() => {
    if (helpOpen) return helpView();
    const o = { selected: cursor, glyphs: g, width: columns - 4 };
    switch (screen) {
      case 'Agents': return agentsView(d, o);
      case 'Memory': return memoryView(d, o);
      case 'Graph': return graphView(d);
      case 'Nano': return nanoView();
      case 'FinOps': return finopsView(d, o);
      default: return null;
    }
  }, [screen, d, cursor, g, columns, helpOpen]);

  useEffect(() => {
    if (view && view.count > 0 && cursor > view.count - 1 && view.focus !== undefined) setCursor(view.count - 1);
  }, [view, cursor]);

  const spin = (busy || job) && motion ? g.spinner[frame] : null;
  const sug = input.startsWith('/') ? matching(input).slice(0, 5) : [];

  let body: ReactNode;
  if (view) {
    const { shown } = windowed(view, cursor, viewH);
    body = <Panel height={bodyHeight} focused g={g}>{shown.map((l, i) => <Segs key={i} line={l} />)}</Panel>;
  } else {
    // Feed shows the newest lines; scrolling up (cursor) moves back through history.
    const feedW = Math.max(10, (wide ? columns - Math.min(54, Math.floor(columns * 0.42)) : columns) - 4);
    const rowsOut = feed.flatMap((f) => wrapText(f.text, feedW).map((t, i) => ({ id: f.id * 100 + i, text: i ? `  ${t}` : t, tone: f.tone })));
    const total = rowsOut.length;
    const back = Math.min(cursor, Math.max(0, total - innerH));
    const start = Math.max(0, total - innerH - back);
    const slice = rowsOut.slice(start, start + innerH);
    const summary = homeSummary(d, g);
    const feedPanel = (
      <Panel title={`Activity${back ? `  ${g.up}${back}` : ''}`} width={wide ? undefined : '100%'} height={wide ? bodyHeight : Math.max(5, bodyHeight - 0)} focused g={g}>
        {slice.length ? slice.map((f) => <Text key={f.id} wrap="truncate-end" color={toneColor(f.tone)} dimColor={f.tone === 'dim'}>{f.text}</Text>) : <Text dimColor>Quiet so far. Activity from your agents shows up here.</Text>}
      </Panel>
    );
    body = wide ? (
      <Box height={bodyHeight} flexShrink={0}>
        <Panel title="Overview" width={Math.min(54, Math.floor(columns * 0.42))} height={bodyHeight} g={g}>{summary.slice(0, innerH).map((l, i) => <Segs key={i} line={l} />)}</Panel>
        <Box flexGrow={1} flexDirection="column">{feedPanel}</Box>
      </Box>
    ) : feedPanel;
  }

  const before = input.slice(0, pos);
  const at = input[pos] ?? ' ';
  const after = input.slice(pos + 1);

  return (
    <Box flexDirection="column" width={columns} height={Math.max(8, rows - 1)} overflow="hidden">
      <Box flexShrink={0}>
        <Text bold color={color.accent}>Tokenistt</Text>
        <Text dimColor>{`  ${d.project.name}${d.project.branch ? ` on ${d.project.branch}` : ''}`}</Text>
        {spin ? <Text color={color.accent}>{`  ${spin}`}</Text> : null}
      </Box>
      <Box flexShrink={0}>
        <Text wrap="truncate-end">
          {SCREENS.map((s, i) => <Text key={s} bold={s === screen} color={s === screen ? color.accent : undefined} dimColor={s !== screen}>{`${i ? '  ' : ''}${s}`}</Text>)}
        </Text>
      </Box>
      {palette ? <Box height={bodyHeight} flexShrink={0} overflow="hidden"><Palette query={palette.query} sel={palette.sel} g={g} width={columns} max={Math.max(1, Math.min(8, bodyHeight - 3))} /></Box> : body}
      <Box borderStyle={g.border === 'round' ? 'round' : 'classic'} borderColor={palette ? color.dim : color.accent} paddingX={1} flexShrink={0}>
        <Text color={color.accent}>{g.prompt} </Text>
        {input || !palette ? (
          input ? <Text>{before}<Text inverse>{at}</Text>{after}</Text> : <Text><Text dimColor>Ask about the codebase, or type / for commands</Text></Text>
        ) : null}
      </Box>
      <Text dimColor wrap="truncate-end">
        {job ? `${g.spinner[frame]} running: ${job.label}   Esc to stop` : helpOpen ? `Esc to close help   ${g.up}${g.down} scroll` : sug.length ? sug.map((c) => `/${c.name}`).join('  ') : `Tab ${g.sep} switch screen   Ctrl+K ${g.sep} palette   ${g.up}${g.down} ${g.sep} scroll   Ctrl+C ${g.sep} quit`}
      </Text>
    </Box>
  );
}

function initialFeed(d: DashboardData): FeedItem[] {
  const recent = [...d.sessions].sort((a, b) => String(b.lastEventAt).localeCompare(String(a.lastEventAt))).slice(0, 6).reverse();
  const lines: Array<{ text: string; tone: Tone }> = recent.map((s) => ({
    text: `${s.agent} ${s.id.slice(0, 8)} ${s.state}${s.branch ? ` on ${s.branch}` : ''}, ${s.counts.filesModified + s.counts.filesCreated} files changed`,
    tone: s.state === 'active' ? 'ok' : 'dim',
  }));
  lines.push({ text: `Ready. ${d.sessions.length} sessions, ${d.memory.active} memories${d.graph ? ', graph indexed' : ', graph not built'}.`, tone: 'normal' });
  lines.push({ text: 'Try:  graph --open   map   /finops   Ctrl+K   help', tone: 'dim' });
  return lines.map((l, id) => ({ ...l, id }));
}

/** What changed between two loads, said in plain words. Only real differences make a line. */
export function changes(a: DashboardData, b: DashboardData): Array<{ text: string; tone: Tone }> {
  const out: Array<{ text: string; tone: Tone }> = [];
  const was = new Map(a.sessions.map((s) => [s.key, s]));
  for (const s of b.sessions) {
    const o = was.get(s.key);
    const tag = `${s.agent} ${s.id.slice(0, 8)}`;
    if (!o) out.push({ text: `${tag} started${s.branch ? ` on ${s.branch}` : ''}`, tone: 'ok' });
    else if (o.state !== s.state) out.push({ text: `${tag} is now ${s.state}`, tone: s.state === 'active' ? 'ok' : 'dim' });
    else if (s.counts.filesModified + s.counts.filesCreated > o.counts.filesModified + o.counts.filesCreated) out.push({ text: `${tag} changed ${s.counts.filesModified + s.counts.filesCreated} files`, tone: 'normal' });
    if (o && s.counts.errors > o.counts.errors) out.push({ text: `${tag} hit ${s.counts.errors - o.counts.errors} new error(s)`, tone: 'warn' });
  }
  if (b.memory.total > a.memory.total) out.push({ text: `${b.memory.total - a.memory.total} new memory entries`, tone: 'normal' });
  if (a.gateway.state !== b.gateway.state) out.push({ text: `Gateway ${b.gateway.state}`, tone: b.gateway.state === 'connected' ? 'ok' : 'warn' });
  return out;
}

/** Breaks a line to fit a width, at spaces where it can, so output is read in full instead of cut with an ellipsis. */
export function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(' ', width);
    const at = cut > width * 0.4 ? cut : width;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
