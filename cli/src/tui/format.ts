export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Text that is safe to put inside a fixed-size frame ─────────────────────────────────────────────────────────────

const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
];

/** How many terminal cells a character takes: 0 for combining marks, 2 for wide and emoji, otherwise 1. */
export function cellOf(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
  for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
  return 1;
}

export function cellWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += cellOf(ch.codePointAt(0) ?? 0);
  return w;
}

/** The longest start of the text that fits the width in cells, with a mark at the end when something was cut. */
export function truncateCells(text: string, width: number, mark = '~'): string {
  if (cellWidth(text) <= width) return text;
  const room = Math.max(0, width - cellWidth(mark));
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = cellOf(ch.codePointAt(0) ?? 0);
    if (used + w > room) break;
    out += ch;
    used += w;
  }
  return out + mark;
}

/** Breaks a line to fit the width in cells, at spaces where it can, so output is read in full instead of cut. */
export function wrapCells(text: string, width: number): string[] {
  const w = Math.max(4, width);
  if (cellWidth(text) <= w) return [text];
  const out: string[] = [];
  let rest = text;
  while (cellWidth(rest) > w) {
    let cut = 0;
    let used = 0;
    let lastSpace = -1;
    for (const ch of rest) {
      const cw = cellOf(ch.codePointAt(0) ?? 0);
      if (used + cw > w) break;
      used += cw;
      cut += ch.length;
      if (ch === ' ') lastSpace = cut;
    }
    const at = lastSpace > cut * 0.4 ? lastSpace : cut;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
    if (at === 0) break;
  }
  if (rest) out.push(rest);
  return out;
}

const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * One line of another program's output made safe to draw: a carriage return keeps only what was written last (a
 * spinner rewrites its own line), escape sequences and control characters go, tabs become spaces.
 */
export function cleanLine(raw: string): string {
  const afterReturn = raw.split('\r').filter((p) => p.length > 0).pop() ?? '';
  return afterReturn.replace(OSC, '').replace(CSI, '').replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trimEnd();
}
