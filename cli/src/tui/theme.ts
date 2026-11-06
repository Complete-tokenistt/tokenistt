/** One place for colour, glyphs and unicode support, so every screen looks the same and degrades the same way. */

export const color = {
  accent: '#6fb3b8',
  text: undefined as string | undefined,
  dim: 'gray',
  ok: '#8fbf8f',
  warn: '#d9b36a',
  err: '#d9786f',
} as const;

export type Tone = 'normal' | 'dim' | 'accent' | 'ok' | 'warn' | 'err';
export const toneColor = (t: Tone | undefined): string | undefined => (t === 'accent' ? color.accent : t === 'ok' ? color.ok : t === 'warn' ? color.warn : t === 'err' ? color.err : undefined);

/** Legacy Windows consoles (conhost) and dumb terminals can't be trusted with box drawing or braille. */
export function unicodeSupported(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (env.TOKENISTT_ASCII === '1') return false;
  if (platform !== 'win32') return env.TERM !== 'linux' && env.TERM !== 'dumb';
  return !!(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuTask === '{cmd::Cmder}' || env.TERM === 'xterm-256color' || env.TERMINAL_EMULATOR === 'JetBrains-JediTerm');
}

export interface Glyphs { spinner: string[]; bullet: string; ring: string; prompt: string; bars: string; border: 'round' | 'classic'; sep: string; up: string; down: string }

export const UNICODE: Glyphs = { spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], bullet: '●', ring: '○', prompt: '›', bars: '▁▂▃▄▅▆▇█', border: 'round', sep: '·', up: '↑', down: '↓' };
export const ASCII: Glyphs = { spinner: ['|', '/', '-', '\\'], bullet: '*', ring: 'o', prompt: '>', bars: '_.-=+*#@', border: 'classic', sep: '-', up: '^', down: 'v' };
