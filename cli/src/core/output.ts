/**
 * Terminal rendering. Business logic returns plain data; this module is the only place that knows
 * about colours, tables, JSON mode and quiet mode.
 *
 *  --json     machine output only (stdout); human chatter is suppressed
 *  --quiet    suppress informational lines; results and errors still print
 *  --verbose  debug lines on stderr (secrets redacted)
 */
import { redactText } from './redact.js';

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
  stdout?: { write(s: string): unknown; isTTY?: boolean };
  stderr?: { write(s: string): unknown; isTTY?: boolean };
}

export interface Column<T> {
  key: keyof T & string;
  header?: string;
  align?: 'left' | 'right';
  format?: (value: T[keyof T], row: T) => string;
}

const ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

export function shouldUseColor(env: NodeJS.ProcessEnv, isTTY: boolean | undefined, noColorFlag: boolean): boolean {
  if (noColorFlag || 'NO_COLOR' in env || env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return !!isTTY;
}

/** Neutralise spreadsheet formula injection, then quote when needed (mirrors the gateway's CSV export). */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly color: boolean;
  private readonly out: NonNullable<OutputOptions['stdout']>;
  private readonly err: NonNullable<OutputOptions['stderr']>;

  constructor(opts: OutputOptions = {}) {
    this.out = opts.stdout ?? process.stdout;
    this.err = opts.stderr ?? process.stderr;
    this.json = !!opts.json;
    this.quiet = !!opts.quiet;
    this.verbose = !!opts.verbose;
    this.color = opts.color ?? false;
  }

  private paint(code: keyof typeof ANSI, s: string): string {
    return this.color ? `${ANSI[code]}${s}${ANSI.reset}` : s;
  }
  bold = (s: string) => this.paint('bold', s);
  dim = (s: string) => this.paint('dim', s);

  /** Informational line: hidden by --quiet and --json. */
  info(message: string): void {
    if (!this.quiet && !this.json) this.out.write(`${message}\n`);
  }
  success(message: string): void {
    this.info(`${this.paint('green', '✔')} ${message}`);
  }
  warn(message: string): void {
    if (!this.json) this.err.write(`${this.paint('yellow', '!')} ${message}\n`);
  }
  /** Debug line on stderr, only with --verbose. Always redacted. */
  debug(message: string): void {
    if (this.verbose) this.err.write(`${this.dim(`[debug] ${redactText(message)}`)}\n`);
  }

  /** Failure: JSON error object on stderr in --json mode, otherwise message + hint. */
  error(message: string, hint?: string, code?: number): void {
    if (this.json) {
      this.err.write(`${JSON.stringify({ error: { message: redactText(message), ...(hint ? { hint } : {}), ...(code !== undefined ? { exit_code: code } : {}) } })}\n`);
      return;
    }
    this.err.write(`${this.paint('red', '✖')} ${redactText(message)}\n`);
    if (hint) this.err.write(`  ${this.dim(hint)}\n`);
  }

  /** The command's result: JSON in --json mode, otherwise whatever `human` renders. Never suppressed by --quiet. */
  result(data: unknown, human: () => void): void {
    if (this.json) this.out.write(`${JSON.stringify(data, null, 2)}\n`);
    else human();
  }

  /** Print a line as part of a result (not suppressed by --quiet). */
  line(s = ''): void {
    this.out.write(`${s}\n`);
  }

  table<T extends object>(rows: T[], columns: Column<T>[]): void {
    if (rows.length === 0) {
      this.line(this.dim('(no data)'));
      return;
    }
    const cells = rows.map((r) => columns.map((c) => {
      const v = (r as Record<string, unknown>)[c.key] as T[keyof T];
      return c.format ? c.format(v, r) : v === null || v === undefined ? '–' : String(v);
    }));
    const headers = columns.map((c) => c.header ?? c.key);
    const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((row) => (row[i] ?? '').length)));
    const fit = (s: string, i: number) => (columns[i]?.align === 'right' ? s.padStart(widths[i] ?? 0) : s.padEnd(widths[i] ?? 0));
    this.line(this.bold(headers.map(fit).join('  ')));
    this.line(this.dim(widths.map((w) => '─'.repeat(w)).join('  ')));
    for (const row of cells) this.line(row.map(fit).join('  ').trimEnd());
  }

  csv<T extends object>(rows: T[], columns: Array<keyof T & string>): string {
    return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell((r as Record<string, unknown>)[c])).join(','))].join('\n') + '\n';
  }
}
