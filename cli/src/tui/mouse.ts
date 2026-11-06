/**
 * Mouse reports from the terminal (SGR mode, \`ESC [ < button ; column ; row M|m\`). Ink has no mouse support and would
 * hand these to the prompt as typed text, so they are recognised here first and never reach it.
 */

export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

export type MouseEvent =
  | { kind: 'wheel'; direction: 'up' | 'down'; x: number; y: number }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'release'; x: number; y: number };

// Ink strips the leading ESC, so it may or may not be there.
const REPORT = /(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Every mouse report in a chunk of input, plus whatever is left once they are removed. */
export function parseMouse(input: string): { events: MouseEvent[]; rest: string } {
  const events: MouseEvent[] = [];
  const rest = input.replace(REPORT, (_all, b: string, x: string, y: string, end: string) => {
    const button = Number(b);
    const col = Number(x);
    const row = Number(y);
    if (button & 64) events.push({ kind: 'wheel', direction: (button & 1) === 0 ? 'up' : 'down', x: col, y: row });
    else if (end === 'M' && (button & 3) === 0 && !(button & 32)) events.push({ kind: 'click', x: col, y: row });
    else if (end === 'm') events.push({ kind: 'release', x: col, y: row });
    return '';
  });
  return { events, rest };
}

/** True when what is left looks like a torn mouse report, so it should not be typed into the prompt either. */
export const looksLikeMouseFragment = (s: string): boolean => /^(?:\x1b)?\[<[\d;]*$/.test(s);

export interface Layout {
  columns: number;
  rows: number;
  bodyHeight: number;
  /** Width of the overview panel on the home screen, or 0 when the feed fills the width. */
  leftWidth: number;
  /** Where each screen's name starts and ends on the tab row, 1-based columns. */
  tabs: Array<{ name: string; from: number; to: number }>;
}

export type Target =
  | { kind: 'tab'; name: string }
  | { kind: 'prompt'; column: number }
  | { kind: 'body'; row: number; column: number; panel: 'left' | 'right' }
  | { kind: 'none' };

export const HEADER_ROWS = 2;
export const PROMPT_ROWS = 3;
export const FOOTER_ROWS = 1;

/** Which part of the screen a click landed on, from the same numbers the renderer lays out with. */
export function hitTest(l: Layout, x: number, y: number): Target {
  if (y === 2) {
    const tab = l.tabs.find((t) => x >= t.from && x <= t.to);
    return tab ? { kind: 'tab', name: tab.name } : { kind: 'none' };
  }
  const bodyTop = HEADER_ROWS + 1;
  const promptTop = bodyTop + l.bodyHeight;
  if (y >= bodyTop && y < promptTop) {
    return { kind: 'body', row: y - bodyTop, column: x, panel: l.leftWidth > 0 && x <= l.leftWidth ? 'left' : 'right' };
  }
  if (y >= promptTop && y < promptTop + PROMPT_ROWS) return { kind: 'prompt', column: x };
  return { kind: 'none' };
}

/** The tab row, as columns, matching how it is drawn: names two spaces apart. */
export function tabSpans(names: readonly string[]): Layout['tabs'] {
  let at = 1;
  return names.map((name, i) => {
    if (i) at += 2;
    const span = { name, from: at, to: at + name.length - 1 };
    at += name.length;
    return span;
  });
}
