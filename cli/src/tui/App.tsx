/** The terminal application: screens, a persistent prompt, a command palette and a streaming activity feed. It only
 * displays what it is given, so it can be tested with plain data and no terminal.
 *
 * The frame is always exactly the size of the terminal (one column spare), every row of it a fixed height, and all
 * text is measured in cells. That keeps Ink on its full-redraw path, which cannot leave old frames behind. */
import { Box, Text, useApp, useInput, useStdout, type Key } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SCREENS, matching, parse, type Screen } from './commands.js';
import type { DashboardData } from './data.js';
import { cleanLine, truncateCells, wrapCells } from './format.js';
import { HEADER_ROWS, PROMPT_ROWS, FOOTER_ROWS, hitTest, looksLikeMouseFragment, parseMouse, tabSpans, type Layout } from './mouse.js';
import { FINOPS_TABS, agentsView, finopsView, graphView, helpView, homeSummary, memoryView, nanoView, type Line, type View } from './screens.js';
import { ASCII, UNICODE, color, toneColor, type Glyphs, type Tone } from './theme.js';

export { SCREENS };
export type { Screen };

const MAX_FEED = 400;
const WHEEL_STEP = 3;
interface FeedItem { id: number; text: string; tone: Tone }

export interface AppProps {
  data: DashboardData;
  motion: boolean;
  initialScreen?: Screen;
  initialFinopsTab?: number;
  /** Fetches fresh data; absent in tests that want a fixed screen. */
  reload?: () => Promise<DashboardData>;
  reloadMs?: number;
  /** Answers plain text typed at the prompt. */
  search?: (text: string) => string[];
  unicode?: boolean;
  /** Runs a real tokenistt command and reports its output as it arrives. Absent in tests that don't need it. */
  exec?: (args: string[], onLine: (line: string) => void) => { done: Promise<number | null>; stop: () => void };
  /** Asks the host to run an interactive command on the real terminal, after the app has exited; the host brings the app back. */
  handOff?: (args: string[]) => void;
}

function Segs({ line }: { line: Line }): ReactNode {
  return (
    <Text wrap="truncate-end" {...(line.selected ? { backgroundColor: color.accent, color: 'black' } : {})}>
      {line.segs.map((s, i) => <Text key={i} bold={s.bold} dimColor={s.tone === 'dim' && !line.selected} color={line.selected ? undefined : toneColor(s.tone)}>{s.t || ' '}</Text>)}
    </Text>
  );
}

/** Shows `height` lines of a view. Selection views keep the focused line centred; others scroll by `cursor`. */
function windowed(view: View, cursor: number, height: number): { shown: Line[]; top: number; max: number } {
  const n = view.lines.length;
  const max = Math.max(0, n - height);
  const top = view.focus !== undefined ? Math.min(max, Math.max(0, view.focus - Math.floor(height / 2))) : Math.min(max, Math.max(0, cursor));
  return { shown: view.lines.slice(top, top + height), top, max };
}

function Panel({ title, width, height, children, focused, g }: { title?: string; width?: number | string; height: number; children: ReactNode; focused?: boolean; g: Glyphs }): ReactNode {
  return (
    <Box flexDirection="column" borderStyle={g.border === 'round' ? 'round' : 'classic'} borderColor={focused ? color.accent : color.dim} paddingX={1} width={width} height={height} overflow="hidden" flexShrink={0}>
      {title ? <Text bold wrap="truncate-end">{title}</Text> : null}
      {children}
    </Box>
  );
}

function Palette({ query, sel, g, width, max }: { query: string; sel: number; g: Glyphs; width: number; max: number }): ReactNode {
  const items = matching(query).slice(0, max);
  return (
    <Box flexDirection="column" borderStyle={g.border === 'round' ? 'round' : 'classic'} borderColor={color.accent} paddingX={1} width={Math.min(64, width)}>
      <Text wrap="truncate-end"><Text color={color.accent}>{g.prompt} </Text>{query}<Text inverse> </Text></Text>
      {items.length ? items.map((c, i) => (
        <Text key={c.name} wrap="truncate-end" {...(i === sel ? { backgroundColor: color.accent, color: 'black' } : {})}>{`/${c.name}${c.arg ? ` ${c.arg}` : ''}`.padEnd(18)}<Text dimColor={i !== sel}>{c.hint}</Text></Text>
      )) : <Text dimColor>No matching command.</Text>}
    </Box>
  );
}

export function App({ data, motion, initialScreen = 'Home', initialFinopsTab = 0, reload, reloadMs = 2000, search, unicode = true, exec, handOff }: AppProps): ReactNode {
  const g = unicode ? UNICODE : ASCII;
  const [d, setD] = useState(data);
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [finopsTab, setFinopsTab] = useState(initialFinopsTab);
  const [cursor, setCursorState] = useState(0);
  const cursorRef = useRef(0);
  const setCursor = (v: number): void => { cursorRef.current = v; setCursorState(v); };
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
  const screenRef = useRef<Screen>(initialScreen);
  const finopsTabRef = useRef(initialFinopsTab);
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
    const items = lines.map((l) => ({ text: cleanLine(l.text), tone: l.tone ?? 'normal' })).filter((l) => l.text.length > 0);
    if (!items.length) return;
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

  const go = useCallback((s: Screen) => { screenRef.current = s; setScreen(s); setCursor(0); }, []);
  const goFinops = (i: number): void => { const n = Math.max(0, Math.min(FINOPS_TABS.length - 1, i)); finopsTabRef.current = n; setFinopsTab(n); setCursor(0); };

  const run = useCallback((text: string) => {
    const a = parse(text);
    if (a.kind === 'none') return;
    if (a.kind !== 'screen' && a.kind !== 'clear') push([{ text: `${g.prompt} ${text.trim()}`, tone: 'accent' }]);
    switch (a.kind) {
      case 'screen': go(a.screen); break;
      case 'quit': exit(); break;
      case 'clear': queue.current = []; setFeed([]); setCursor(0); break;
      case 'help': setHelpOpen(true); setCursor(0); break;
      case 'terminal':
        if (a.command === 'watch') {
          // The Agents screen is the live view, refreshed every couple of seconds, so there is nothing to leave for.
          push([{ text: 'Live sessions are on this Agents screen and update on their own.', tone: 'accent' }]);
          go('Agents');
        } else if (handOff && a.command !== 'mcp') {
          // Hand the whole terminal to the command (a login prompt, setup, your agent); the dashboard returns afterwards.
          handOff(a.line.split(/\s+/));
          exit();
        } else {
          push([{ text: `${a.command} needs a terminal of its own. Quit (Ctrl+C) and run: tokenistt ${a.line}`, tone: 'warn' }]);
          go('Home');
        }
        break;
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

  // What the renderer last drew, so a click or a scroll can be mapped onto it.
  const layoutRef = useRef<Layout>({ columns: 80, rows: 24, bodyHeight: 10, leftWidth: 0, tabs: [] });
  const viewRef = useRef<View | null>(null);
  const windowRef = useRef({ top: 0, max: 0, feedMax: 0, viewH: 1 });
  const promptRef = useRef({ start: 0 });

  /** Positive moves down the screen (towards newer lines in the feed). Always stays within what exists. */
  const scrollBy = (delta: number): void => {
    const w = windowRef.current;
    const v = viewRef.current;
    if (v && v.focus !== undefined && !helpOpenRef.current) setCursor(Math.max(0, Math.min(Math.max(0, v.count - 1), cursorRef.current + delta)));
    else if (v) setCursor(Math.max(0, Math.min(w.max, cursorRef.current + delta)));
    else setCursor(Math.max(0, Math.min(w.feedMax, cursorRef.current - delta)));
  };
  const scrollTo = (where: 'start' | 'end'): void => {
    const w = windowRef.current;
    const v = viewRef.current;
    if (v) setCursor(where === 'start' ? 0 : v.focus !== undefined ? Math.max(0, v.count - 1) : w.max);
    else setCursor(where === 'start' ? w.feedMax : 0);
  };

  const onMouse = (events: ReturnType<typeof parseMouse>['events']): void => {
    for (const e of events) {
      if (e.kind === 'wheel') {
        if (!paletteRef.current) scrollBy(e.direction === 'up' ? -WHEEL_STEP : WHEEL_STEP);
        continue;
      }
      if (e.kind !== 'click') continue;
      const t = hitTest(layoutRef.current, e.x, e.y);
      if (t.kind === 'tab') {
        setPalette(null); setHelpOpen(false);
        go(t.name as Screen);
      } else if (t.kind === 'prompt') {
        // Clicking the prompt is how you start typing: close whatever is covering the screen and put the caret there.
        setPalette(null); setHelpOpen(false);
        const text = inputRef.current;
        const col = t.column - 5 + promptRef.current.start;
        setPos(Math.max(0, Math.min(text.length, col)));
      } else if (t.kind === 'body' && !paletteRef.current) {
        const v = viewRef.current;
        if (!v) continue;
        const line = windowRef.current.top + (t.row - 1);
        if (v.tabs && line === 0) {
          const spans = tabSpans(v.tabs.names);
          const hit = spans.find((s) => t.column - 2 >= s.from && t.column - 2 <= s.to);
          if (hit) goFinops(v.tabs.names.indexOf(hit.name));
        } else if (v.itemAt && !helpOpenRef.current) {
          const item = v.itemAt.get(line);
          if (item !== undefined) setCursor(item);
        }
      }
    }
  };

  // Ink re-subscribes whenever the handler changes, and a key arriving in that gap is lost. A stable function avoids it.
  const handler = useRef<(ch: string, key: Key) => void>(() => undefined);
  handler.current = (rawCh, key) => {
    // Mouse reports arrive as input too. They are handled here and never typed into the prompt.
    let ch = rawCh;
    const mouse = parseMouse(rawCh);
    if (mouse.events.length || looksLikeMouseFragment(mouse.rest)) {
      onMouse(mouse.events);
      if (!mouse.rest || looksLikeMouseFragment(mouse.rest)) return;
      ch = mouse.rest;
    }
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
      else if (key.upArrow) scrollBy(-1);
      else if (key.downArrow) scrollBy(1);
      else if (key.pageUp) scrollBy(-(windowRef.current.viewH - 1));
      else if (key.pageDown) scrollBy(windowRef.current.viewH - 1);
      else if (key.home) scrollTo('start');
      else if (key.end) scrollTo('end');
      return;
    }
    if (key.ctrl && ch === 'd' && !input) { exit(); return; }
    if (key.ctrl && ch === 'l') { queue.current = []; setFeed([]); setCursor(0); return; }
    if (key.ctrl && ch === 'u') { setInput(input.slice(pos)); setPos(0); return; }
    if (key.tab) {
      if (input.startsWith('/') && !key.shift) {
        const m = matching(input)[0];
        if (m) { const t = `/${m.name}${m.arg ? ' ' : ''}`; setInput(t); setPos(t.length); }
        return;
      }
      const i = SCREENS.indexOf(screenRef.current);
      go(SCREENS[(i + (key.shift ? -1 : 1) + SCREENS.length) % SCREENS.length]!);
      return;
    }
    if (key.return) { const t = input; setInput(''); setPos(0); run(t); return; }
    if (key.escape) {
      if (!input && jobRef.current) jobRef.current.stop();
      setInput(''); setPos(0);
      return;
    }
    const onFinops = screenRef.current === 'FinOps';
    if (onFinops && !input && (ch === ']' || key.rightArrow)) { goFinops(finopsTabRef.current + 1); return; }
    if (onFinops && !input && (ch === '[' || key.leftArrow)) { goFinops(finopsTabRef.current - 1); return; }
    if (key.upArrow) { scrollBy(-1); return; }
    if (key.downArrow) { scrollBy(1); return; }
    if (key.pageUp) { scrollBy(-(windowRef.current.viewH - 1)); return; }
    if (key.pageDown) { scrollBy(windowRef.current.viewH - 1); return; }
    if (key.home && !input) { scrollTo('start'); return; }
    if (key.end && !input) { scrollTo('end'); return; }
    if (key.home) { setPos(0); return; }
    if (key.end) { setPos(input.length); return; }
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

  // One column is left spare, and the frame is exactly as tall as the terminal. Neither is wasted: both are what keep
  // a terminal from wrapping or scrolling a frame, which is what leaves old frames behind.
  const columns = Math.max(40, size.columns - 1);
  const rows = Math.max(12, size.rows);
  const wide = columns >= 90;
  const bodyHeight = Math.max(5, rows - HEADER_ROWS - PROMPT_ROWS - FOOTER_ROWS);
  const innerH = Math.max(1, bodyHeight - 3);
  const viewH = Math.max(1, bodyHeight - 2);
  const leftWidth = Math.min(54, Math.floor(columns * 0.42));

  const view: View | null = useMemo(() => {
    if (helpOpen) return helpView();
    const o = { selected: cursor, glyphs: g, width: columns - 4, finopsTab };
    switch (screen) {
      case 'Agents': return agentsView(d, o);
      case 'Memory': return memoryView(d, o);
      case 'Graph': return graphView(d);
      case 'Nano': return nanoView();
      case 'FinOps': return finopsView(d, o);
      default: return null;
    }
  }, [screen, d, cursor, g, columns, helpOpen, finopsTab]);
  viewRef.current = view;

  const spin = (busy || job) && motion ? g.spinner[frame] : null;
  const sug = input.startsWith('/') ? matching(input).slice(0, 5) : [];

  // Feed rows are wrapped to the panel's real inner width, in cells.
  const feedW = Math.max(10, (wide ? columns - leftWidth : columns) - 4);
  const rowsOut = useMemo(() => feed.flatMap((f) => wrapCells(f.text, feedW).map((t, i) => ({ id: f.id * 100 + i, text: i ? `  ${t}` : t, tone: f.tone }))), [feed, feedW]);
  const total = rowsOut.length;
  const feedMax = Math.max(0, total - innerH);

  // Scrolled back through the feed: new lines must not drag the view, so the offset grows with them.
  const seen = useRef(total);
  useEffect(() => {
    if (total > seen.current && cursorRef.current > 0 && !viewRef.current) setCursor(Math.min(feedMax, cursorRef.current + (total - seen.current)));
    seen.current = total;
  }, [total, feedMax]);

  let body: ReactNode;
  let scrollNote = '';
  if (view) {
    const w = windowed(view, cursor, viewH);
    windowRef.current = { top: w.top, max: w.max, feedMax, viewH };
    body = <Panel height={bodyHeight} focused g={g}>{w.shown.map((l, i) => <Segs key={i} line={l} />)}</Panel>;
    if (view.lines.length > viewH) scrollNote = `lines ${w.top + 1}-${Math.min(view.lines.length, w.top + viewH)} of ${view.lines.length}`;
  } else {
    const back = Math.min(cursor, feedMax);
    const start = Math.max(0, total - innerH - back);
    const slice = rowsOut.slice(start, start + innerH);
    windowRef.current = { top: 0, max: 0, feedMax, viewH };
    const summary = homeSummary(d, g);
    const title = back ? `Activity   ${g.up}${back} older  (End: latest)` : 'Activity';
    const feedPanel = (
      <Panel title={title} width={wide ? columns - leftWidth : columns} height={bodyHeight} focused g={g}>
        {slice.length ? slice.map((f) => <Text key={f.id} wrap="truncate-end" color={toneColor(f.tone)} dimColor={f.tone === 'dim'}>{f.text}</Text>) : <Text dimColor>Quiet so far. Activity from your agents shows up here.</Text>}
      </Panel>
    );
    body = wide ? (
      <Box height={bodyHeight} width={columns} flexShrink={0}>
        <Panel title="Overview" width={leftWidth} height={bodyHeight} g={g}>{summary.slice(0, innerH).map((l, i) => <Segs key={i} line={l} />)}</Panel>
        {feedPanel}
      </Box>
    ) : feedPanel;
    if (feedMax > 0) scrollNote = back ? `${back} older lines above` : 'scroll up for older';
  }

  const tabs = tabSpans(SCREENS);
  layoutRef.current = { columns, rows, bodyHeight, leftWidth: !view && wide ? leftWidth : 0, tabs };

  // The prompt shows a window of the text that always contains the caret, so long input scrolls sideways, never wraps.
  const textW = Math.max(4, columns - 2 - 2 - 2);
  const start = pos > textW - 1 ? pos - (textW - 1) : 0;
  promptRef.current = { start };
  const at = input[pos] ?? ' ';
  const before = input.slice(start, pos);
  const after = input.slice(pos + 1, start + textW);
  const placeholder = truncateCells('Ask about the codebase, or type / for commands', textW - 1);

  const hint = job
    ? `${g.spinner[frame]} running: ${job.label}   Esc to stop`
    : helpOpen ? `Esc to close help   ${g.up}${g.down} scroll`
      : sug.length ? sug.map((c) => `/${c.name}`).join('  ')
        : `Tab ${g.sep} screen   Ctrl+K ${g.sep} palette   ${g.up}${g.down} wheel ${g.sep} scroll${scrollNote ? ` (${scrollNote})` : ''}   Ctrl+C ${g.sep} quit`;

  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      <Box height={1} width={columns} flexShrink={0}>
        <Text bold color={color.accent} wrap="truncate-end">Tokenistt</Text>
        <Text dimColor wrap="truncate-end">{truncateCells(`  ${d.project.name}${d.project.branch ? ` on ${d.project.branch}` : ''}`, columns - 14)}</Text>
        {spin ? <Text color={color.accent}>{`  ${spin}`}</Text> : null}
      </Box>
      <Box height={1} width={columns} flexShrink={0}>
        <Text wrap="truncate-end">
          {SCREENS.map((s, i) => <Text key={s} bold={s === screen} color={s === screen ? color.accent : undefined} dimColor={s !== screen}>{`${i ? '  ' : ''}${s}`}</Text>)}
        </Text>
      </Box>
      {palette ? <Box height={bodyHeight} flexShrink={0} overflow="hidden"><Palette query={palette.query} sel={palette.sel} g={g} width={columns} max={Math.max(1, Math.min(8, bodyHeight - 3))} /></Box> : body}
      <Box borderStyle={g.border === 'round' ? 'round' : 'classic'} borderColor={palette ? color.dim : color.accent} paddingX={1} height={PROMPT_ROWS} width={columns} flexShrink={0} overflow="hidden">
        <Text color={color.accent}>{g.prompt} </Text>
        {input ? <Text wrap="truncate">{before}<Text inverse>{at}</Text>{after}</Text> : <Text wrap="truncate"><Text inverse> </Text><Text dimColor>{placeholder}</Text></Text>}
      </Box>
      <Box height={FOOTER_ROWS} width={columns} flexShrink={0}>
        <Text dimColor wrap="truncate-end">{hint}</Text>
      </Box>
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

/** Breaks a line to fit a width in terminal cells, so output is read in full instead of cut with an ellipsis. */
export function wrapText(text: string, width: number): string[] {
  return wrapCells(text, width);
}
