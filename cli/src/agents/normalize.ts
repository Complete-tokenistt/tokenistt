/** Helpers shared by adapters. Kept free of heavy imports: this runs on the hook fast path. */
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { redactText } from '../core/redact.js';
import type { CommandPrivacy } from './schemas.js';

export const SAFE_SESSION = /^[A-Za-z0-9_.-]{1,128}$/;

export function eventId(parts: Array<string | number | undefined>): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('|')).digest('hex').slice(0, 32);
}

/** Repo-relative with forward slashes, or undefined for anything outside the repository. */
export function repoPath(root: string, cwd: string | undefined, path: unknown): string | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  const abs = isAbsolute(path) ? path : resolve(cwd ?? root, path);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  const out = rel.split(sep).join('/');
  return out.startsWith('.tokenistt/') ? undefined : out;
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUBCOMMAND = /^[a-z][a-z0-9:_-]*$/;
/** Tools whose second word names an action. For anything else it could be a password or a path, so it is not kept. */
const SUBCOMMAND_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'git', 'gh', 'docker', 'kubectl', 'helm', 'terraform', 'cargo', 'go', 'dotnet', 'pip', 'pip3', 'uv', 'poetry', 'make', 'mvn', 'gradle', 'composer', 'bundle', 'rails', 'tokenistt']);

/** Words of a command, ignoring leading VAR=value and prefixes like sudo. */
function commandWords(command: string): string[] {
  const words = command.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && ENV_ASSIGN.test(words[i] ?? '')) i++;
  if (words[i] === 'sudo' || words[i] === 'env' || words[i] === 'npx' || words[i] === 'time') i++;
  return words.slice(i);
}

/**
 * Agents chain commands, as in `cd app && npm test`, so the first word is rarely the point. This finds the first
 * step that does something. Text is split without parsing quotes, which is fine: only program names come out.
 */
const NAVIGATION = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'source', '.', 'true', ':']);

function mainStep(command: string): string[] {
  let first: string[] | undefined;
  for (const step of command.split(/&&|\|\||;|\||\r?\n/)) {
    const words = commandWords(step);
    if (!words[0]) continue;
    first ??= words;
    if (!NAVIGATION.has(words[0])) return words;
  }
  return first ?? [];
}

/** `npm test --watch` becomes `npm test`. Arguments can hold secrets, so by default they are not recorded. */
export function commandName(command: string): string {
  const [program = '', second] = mainStep(command);
  const base = program.split(/[\\/]/).pop() ?? program;
  return second && SUBCOMMAND_TOOLS.has(base) && SUBCOMMAND.test(second) ? `${base} ${second}` : base;
}

export function redactCommand(command: string): string {
  return redactText(command)
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)=\S+/gi, '$1=[REDACTED]')
    .replace(/(--?(?:password|passwd|token|secret|api-key|apikey|key)[= ])\S+/gi, '$1[REDACTED]')
    .replace(/(:\/\/[^\s:/@]+:)[^\s@]+@/g, '$1[REDACTED]@')
    .slice(0, 500);
}

export function shapeCommand(command: unknown, privacy: CommandPrivacy): string | undefined {
  if (typeof command !== 'string' || privacy === 'none') return undefined;
  return privacy === 'redacted' ? redactCommand(command) : commandName(command);
}

const TEST_COMMAND = /(^|\s|\/)(jest|vitest|mocha|pytest|rspec|phpunit|ava|tap)(\s|$)|(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)(\s|$|:)|(^|\s)go\s+test(\s|$)|(^|\s)cargo\s+(test|nextest)(\s|$)|(^|\s)dotnet\s+test(\s|$)|(^|\s)(mvn|gradle|\.\/gradlew|\.\/mvnw)\s+(\S+\s+)*test(\s|$)|(^|\s)python3?\s+-m\s+(pytest|unittest)(\s|$)|--test(\s|$)/;

/** Recognises common test runners from the command line. A custom script name goes unnoticed. */
export function isTestCommand(command: unknown): boolean {
  return typeof command === 'string' && TEST_COMMAND.test(command);
}

/** Paths from a plain `rm` with no shell syntax. Anything fancier is not interpreted. */
export function deletedPaths(command: unknown): string[] {
  if (typeof command !== 'string' || /[|&;<>$`*?(){}\[\]"'\\\n]/.test(command)) return [];
  const words = command.trim().split(/\s+/);
  if (words[0] !== 'rm' && words[0] !== 'git') return [];
  const args = words[0] === 'git' ? (words[1] === 'rm' ? words.slice(2) : []) : words.slice(1);
  return args.filter((a) => !a.startsWith('-'));
}
