/**
 * The app drawn into a real terminal emulator. ink-testing-library renders in Ink's debug mode, which never erases
 * anything, so it cannot see the bugs that matter on a real terminal: frames stacking, a prompt drawn twice, a screen
 * that scrolls. Here Ink runs normally and its output goes through xterm's parser.
 */
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { render } from 'ink';
import { App } from '../src/tui/App.js';
import { data } from './tui-fixtures.js';

interface Emulator { cols: number; rows: number; screen(): string[]; scrolled(): number; flush(): Promise<void>; resize(c: number, r: number): void }
const Terminal = (headless as unknown as { Terminal: new (o: object) => any }).Terminal; // eslint-disable-line @typescript-eslint/no-explicit-any

class Out extends EventEmitter {
  isTTY = true;
  constructor(public columns: number, public rows: number, private term: { write(d: string, cb?: () => void): void }) { super(); }
  write = (chunk: string): boolean => { this.term.write(chunk); return true; };
}

class In extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  write = (data: string): void => { this.queue.push(data); this.emit('readable'); };
  read = (): string | null => this.queue.shift() ?? null;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

const settle = (ms = 140): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Waits until the screen has stopped changing, so a slow machine is waited for rather than raced. */
async function quiet(term: { screen(): string[]; flush(): Promise<void> }, still = 250, max = 15_000): Promise<void> {
  const start = Date.now();
  let last = '';
  let since = Date.now();
  while (Date.now() - start < max) {
    await term.flush();
    const now = term.screen().join('\n');
    if (now !== last) { last = now; since = Date.now(); }
    else if (Date.now() - since >= still) return;
    await settle(25);
  }
}

/** Waits for something to appear on the screen. */
async function waitFor(term: { screen(): string[]; flush(): Promise<void> }, re: RegExp, max = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < max) {
    await term.flush();
    if (re.test(term.screen().join('\n'))) return;
    await settle(25);
  }
}

async function boot(cols: number, rows: number, props: Partial<Parameters<typeof App>[0]> = {}): Promise<{ term: Emulator; stdin: In; stdout: Out; stop: () => void }> {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 500, convertEol: true });
  const stdout = new Out(cols, rows, t);
  const stdin = new In();
  const app = render(<App data={data()} motion={false} {...props} />, { stdout: stdout as never, stdin: stdin as never, stderr: new Out(cols, rows, t) as never, exitOnCtrlC: false, patchConsole: false, maxFps: 60 });
  const term: Emulator = {
    cols, rows,
    screen: () => Array.from({ length: t.rows }, (_v, y) => t.buffer.active.getLine(t.buffer.active.viewportY + y)?.translateToString(true) ?? ''),
    scrolled: () => t.buffer.active.baseY as number,
    flush: () => new Promise<void>((r) => t.write('', r)),
    resize: (c, r) => { t.resize(c, r); stdout.columns = c; stdout.rows = r; stdout.emit('resize'); },
  };
  await waitFor(term, /Tokenistt/);
  await quiet(term);
  return { term, stdin, stdout, stop: () => app.unmount() };
}

/** What a healthy screen looks like, whatever is on it. */
function assertHealthy(term: Emulator, where: string): void {
  const s = term.screen();
  const rows = s.length;
  assert.equal(term.scrolled(), 0, `${where}: the screen scrolled, so frames are stacking`);
  assert.match(s[0] ?? '', /^Tokenistt/, `${where}: header`);
  const footer = s[rows - 1] ?? '';
  assert.ok(footer.trim().length > 0, `${where}: footer present`);
  // The prompt box: top border, one line starting with the prompt glyph, bottom border, then the footer.
  const top = s[rows - 4] ?? '';
  const mid = s[rows - 3] ?? '';
  const bottom = s[rows - 2] ?? '';
  assert.match(top, /^[╭+]/, `${where}: prompt top border: ${JSON.stringify(top)}`);
  assert.match(mid, /^[│|] [›>] /, `${where}: prompt line: ${JSON.stringify(mid)}`);
  assert.match(bottom, /^[╰+]/, `${where}: prompt bottom border: ${JSON.stringify(bottom)}`);
  const prompts = s.filter((l) => /^[│|] [›>] (?:\S| )*$/.test(l) && /Ask about the codebase/.test(l));
  assert.ok(prompts.length <= 1, `${where}: the placeholder is drawn ${prompts.length} times`);
  for (const l of s) assert.ok([...l].length <= term.cols, `${where}: a line is wider than the terminal`);
}

describe('the app in a terminal emulator', () => {
  for (const [cols, rows] of [[80, 24], [120, 30], [60, 14], [100, 20]] as const) {
    it(`draws one clean frame at ${cols}x${rows} and keeps it clean while typing, running commands and scrolling`, async () => {
      let finish: (c: number | null) => void = () => undefined;
      const exec = (_args: string[], on: (l: string) => void) => {
        // What a real command prints: a spinner that rewrites its line, colour codes, and a long line.
        on('\x1b[32m✔\x1b[0m Starting\rViewer running at http://127.0.0.1:50457/?t=NoDdRC3uhMKI2r0AN0bkN3UT_Da1BInf');
        on('x'.repeat(400));
        for (let i = 0; i < 60; i++) on(`line ${i}`);
        return { done: new Promise<number | null>((r) => { finish = r; }), stop: () => finish(null) };
      };
      const { term, stdin, stop } = await boot(cols, rows, { exec });
      assertHealthy(term, 'start');
      for (const ch of 'hello') { stdin.write(ch); await settle(15); }
      await quiet(term);
      assertHealthy(term, 'typing');
      assert.match(term.screen()[rows - 3] ?? '', /hello/);
      for (const ch of 'graph --open') { stdin.write(ch); await settle(5); }
      stdin.write('\x1b'); await settle();
      for (const ch of 'graph --open') { stdin.write(ch); await settle(5); }
      stdin.write('\r'); await quiet(term);
      assertHealthy(term, 'running a command');
      assert.match(term.screen().join('\n'), /line 59/, 'follows the newest line');
      stdin.write('\x1b[H'); await quiet(term);
      assert.match(term.screen().join('\n'), /older/, 'Home goes back through the feed');
      if (rows >= 20) assert.match(term.screen().join('\n'), /Viewer running at/, 'to the oldest line');
      assert.doesNotMatch(term.screen().join('\n'), /\x1b|Starting/, 'the spinner frame and colour codes are gone');
      assertHealthy(term, 'oldest line');
      stdin.write('\x1b[F'); await settle();
      for (let i = 0; i < 12; i++) { stdin.write('\x1b[A'); await settle(10); }
      await quiet(term);
      assertHealthy(term, 'scrolled up');
      for (let i = 0; i < 12; i++) { stdin.write('\x1b[B'); await settle(10); }
      for (const tab of ['\t', '\t', '\t', '\t', '\t']) { stdin.write(tab); await settle(40); }
      await quiet(term);
      assertHealthy(term, 'on FinOps');
      finish(0);
      stop();
    });
  }

  it('redraws cleanly when the window is resized, bigger or smaller', async () => {
    const { term, stop } = await boot(100, 30);
    assertHealthy(term, 'start');
    for (const [c, r] of [[70, 18], [140, 40], [60, 14], [100, 30]] as const) {
      term.resize(c, r);
      await quiet(term);
      assertHealthy({ ...term, cols: c, rows: r, screen: term.screen, scrolled: term.scrolled, flush: term.flush, resize: term.resize }, `resized to ${c}x${r}`);
    }
    stop();
  });

  it('scrolls the feed with the wheel, and a click on the prompt puts the caret where it was clicked', async () => {
    const exec = (_a: string[], on: (l: string) => void) => { for (let i = 0; i < 80; i++) on(`output ${i}`); return { done: Promise.resolve(0), stop: () => undefined }; };
    const { term, stdin, stop } = await boot(100, 30, { exec });
    for (const ch of 'doctor') { stdin.write(ch); await settle(5); }
    stdin.write('\r'); await quiet(term);
    assert.match(term.screen().join('\n'), /output 79/);
    for (let i = 0; i < 5; i++) { stdin.write('\x1b[<64;40;10M'); await settle(20); }
    await quiet(term);
    assert.match(term.screen().join('\n'), /older/, 'wheel up goes back through the feed');
    assert.doesNotMatch(term.screen().join('\n'), /output 79/);
    for (let i = 0; i < 10; i++) { stdin.write('\x1b[<65;40;10M'); await settle(20); }
    await quiet(term);
    assert.match(term.screen().join('\n'), /output 79/, 'wheel down comes back to the newest');
    // Type, then click earlier in the text and type again: the new text lands where the click was.
    for (const ch of 'abcdef') { stdin.write(ch); await settle(5); }
    stdin.write('\x1b[<0;8;27M'); await settle(40);
    stdin.write('X'); await quiet(term);
    assert.match(term.screen()[27] ?? '', /abcXdef|abXcdef|aXbcdef|Xabcdef/, 'the click moved the caret');
    assertHealthy(term, 'after clicking');
    stop();
  });

  it('never types a mouse report into the prompt, and the wheel and a click do what they should', async () => {
    const { term, stdin, stop } = await boot(100, 30);
    // A click on the prompt row, then a wheel turn. Neither may appear as text.
    stdin.write('\x1b[<0;10;27M'); await settle(30);
    stdin.write('\x1b[<64;40;10M'); await settle(30);
    stdin.write('\x1b[<65;40;10M'); await settle(30);
    stdin.write('\x1b[<0;10;27m'); await settle();
    await quiet(term);
    const s = term.screen();
    assert.doesNotMatch(s.join('\n'), /\[<|;\d+M/, 'no mouse report leaked onto the screen');
    assert.match(s[s.length - 3] ?? '', /Ask about the codebase/, 'the prompt is still empty');
    assertHealthy(term, 'after mouse input');
    stop();
  });
});
