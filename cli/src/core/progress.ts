/**
 * Multi-stage progress on stderr, so stdout stays pipeable. Everything shown comes from real work:
 * a stage has a count only when the caller knows it, and there are no invented percentages.
 *
 *  - TTY with motion: one line redrawn in place, with a spinner.
 *  - Non-TTY, CI or reduced motion: one permanent line per finished stage, no redraws.
 *  - --json or --quiet: silent.
 */
export function motionAllowed(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  if (!isTTY || env.TERM === 'dumb') return false;
  return !env.CI && !env.TOKENISTT_REDUCED_MOTION;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\r\x1b[K';

export interface ProgressOptions {
  silent?: boolean;
  motion?: boolean;
  color?: boolean;
  stream?: { write(s: string): unknown };
  intervalMs?: number;
}

export class Progress {
  private readonly stream: { write(s: string): unknown };
  private readonly silent: boolean;
  private readonly motion: boolean;
  private readonly color: boolean;
  private readonly intervalMs: number;
  private label: string | undefined;
  private counts = '';
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly restore = () => { this.stream.write(SHOW_CURSOR); };

  constructor(opts: ProgressOptions = {}) {
    this.stream = opts.stream ?? process.stderr;
    this.silent = !!opts.silent;
    this.motion = !!opts.motion && !this.silent;
    this.color = !!opts.color;
    this.intervalMs = opts.intervalMs ?? 80;
  }

  private paint(code: number, s: string): string {
    return this.color ? `\x1b[${code}m${s}\x1b[0m` : s;
  }

  private draw(): void {
    if (!this.motion || this.label === undefined) return;
    this.frame = (this.frame + 1) % FRAMES.length;
    this.stream.write(`${CLEAR_LINE}${this.paint(36, FRAMES[this.frame] ?? '')} ${this.label}${this.counts}`);
  }

  start(label: string): void {
    this.settle();
    this.label = label;
    this.counts = '';
    if (!this.motion) return;
    if (!this.timer) {
      this.stream.write(HIDE_CURSOR);
      process.once('exit', this.restore);
      this.timer = setInterval(() => this.draw(), this.intervalMs);
      this.timer.unref();
    }
    this.draw();
  }

  /** Report real counts. `total` is left out when the amount of work is not known up front. */
  update(done: number, total?: number): void {
    this.counts = total === undefined ? `  ${done}` : `  ${done}/${total}`;
  }

  private finish(symbol: string, code: number, detail?: string): void {
    if (this.label === undefined || this.silent) {
      this.label = undefined;
      return;
    }
    const tail = detail ? `  ${detail}` : '';
    this.stream.write(`${this.motion ? CLEAR_LINE : ''}${this.paint(code, symbol)} ${this.label}${tail}\n`);
    this.label = undefined;
  }

  succeed(detail?: string): void {
    this.finish('✔', 32, detail);
  }
  fail(detail?: string): void {
    this.finish('✖', 31, detail);
  }
  skip(detail?: string): void {
    this.finish('–', 2, detail);
  }

  /** A stage left open is abandoned without being reported as done. */
  private settle(): void {
    if (this.label !== undefined && this.motion) this.stream.write(CLEAR_LINE);
    this.label = undefined;
  }

  stop(): void {
    this.settle();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      process.removeListener('exit', this.restore);
      this.restore();
    }
  }
}
