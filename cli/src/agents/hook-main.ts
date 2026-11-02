/**
 * The hook fast path: `tokenistt hook <agent>`, run by the agent on every event, so it has to be quick and invisible.
 * It reads stdin, appends normalized events to a file and exits. It never fails the agent: whatever goes wrong, the
 * exit code is 0 and stdout stays empty (an agent may read stdout as instructions). Events are ingested into SQLite
 * later, by the commands that need them, so nothing here waits on a database.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SAFE_SESSION } from './normalize.js';
import { adapterFor } from './registry.js';
import type { CommandPrivacy, NormalizeContext } from './schemas.js';

const MAX_STDIN = 8 * 1024 * 1024;

/** Walks up to the project without spawning git, which would cost tens of milliseconds per tool call. */
export function findProjectRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.tokenistt', 'config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Reads .git/HEAD directly, following the pointer file a worktree has instead of a directory. */
export function currentBranch(root: string): string | undefined {
  try {
    let gitDir = join(root, '.git');
    const pointer = readFileSync(gitDir, 'utf8');
    gitDir = resolve(root, pointer.replace(/^gitdir:\s*/, '').trim());
    return branchFromHead(gitDir);
  } catch {
    return branchFromHead(join(root, '.git'));
  }
}

function branchFromHead(gitDir: string): string | undefined {
  try {
    return /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(gitDir, 'HEAD'), 'utf8'))?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function readPrivacy(root: string): NormalizeContext['privacy'] {
  try {
    const cfg = JSON.parse(readFileSync(join(root, '.tokenistt', 'config.json'), 'utf8')) as { privacy?: { commands?: unknown; capturePrompts?: unknown } };
    const c = cfg.privacy?.commands;
    return {
      // Anything unexpected falls back to the private default.
      commands: c === 'none' || c === 'redacted' ? (c as CommandPrivacy) : 'name',
      capturePrompts: cfg.privacy?.capturePrompts === true,
    };
  } catch {
    return { commands: 'name', capturePrompts: false };
  }
}

export function handleHook(agent: string, stdin: string, now: Date = new Date()): number {
  const input = JSON.parse(stdin) as Record<string, unknown>;
  const adapter = adapterFor(agent);
  const cwd = adapter.hookCwd ? adapter.hookCwd(input) : typeof input.cwd === 'string' ? input.cwd : undefined;
  if (!cwd) return 0;
  const root = findProjectRoot(cwd);
  if (!root) return 0;
  const branch = currentBranch(root);
  const events = adapter.normalizeEvent(input, { root, now, privacy: readPrivacy(root), ...(branch ? { branch } : {}) });
  let written = 0;
  for (const e of events) {
    if (!SAFE_SESSION.test(e.session)) continue;
    const dir = join(root, '.tokenistt', 'sessions');
    mkdirSync(dir, { recursive: true });
    // One small append per event: concurrent sessions each have their own file.
    appendFileSync(join(dir, `${e.agent}.${e.session}.jsonl`), `${JSON.stringify(e)}\n`);
    written++;
  }
  return written;
}

export async function runHook(argv: string[]): Promise<void> {
  try {
    const agent = argv[3];
    if (!agent) return;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of process.stdin) {
      size += (c as Buffer).length;
      if (size > MAX_STDIN) return;
      chunks.push(c as Buffer);
    }
    handleHook(agent, Buffer.concat(chunks).toString('utf8'));
  } catch {
    // Observability must never get in the way of the agent.
  } finally {
    process.exitCode = 0;
  }
}
