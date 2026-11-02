/** Minimal interactive input, no dependency. Non-interactive sessions get a clear error instead of hanging. */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { UsageError } from './errors.js';

export const isInteractive = (): boolean => !!process.stdin.isTTY && !!process.stderr.isTTY;

function requireTty(what: string): void {
  if (!isInteractive()) {
    throw new UsageError(
      `Cannot prompt for ${what} in a non-interactive session.`,
      'Pass it through an environment variable or a --…-stdin flag (see `tokenistt login --help`).',
    );
  }
}

export async function ask(question: string, fallback?: string): Promise<string> {
  requireTty(question);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const suffix = fallback ? ` (${fallback})` : '';
  const answer = await new Promise<string>((resolve) => rl.question(`${question}${suffix}: `, resolve));
  rl.close();
  return answer.trim() || fallback || '';
}

/** Anything but an explicit yes is a no. */
export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N]`));
}

/** Prompt without echoing what is typed. */
export async function askSecret(question: string): Promise<string> {
  requireTty(question);
  let muted = false;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  const pending = new Promise<string>((resolve) => rl.question(`${question}: `, resolve));
  muted = true;
  const answer = await pending;
  muted = false;
  rl.close();
  process.stderr.write('\n');
  return answer.trim();
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError('Expected the value on stdin, but stdin is a terminal.', 'Pipe it in, e.g. `printf %s "$TOKEN" | tokenistt login --token-stdin`.');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}
