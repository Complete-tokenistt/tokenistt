/**
 * Installs and removes our hook entries in an agent's documented config. This edits a file the user owns, so it is
 * careful: everything else in the file is preserved, invalid JSON is refused rather than overwritten, a backup is
 * written first, and removal takes out only entries that are recognisably ours.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from '../core/errors.js';
import type { AgentAdapter, HookTarget } from './adapter.js';

const BIN = fileURLToPath(new URL('../../bin/tokenistt.js', import.meta.url));

/** Absolute paths, so the hook runs whatever PATH the agent happens to have. */
export function hookCommand(agent: string, execPath = process.execPath, bin = BIN): string {
  return `"${execPath}" "${bin}" hook ${agent}`;
}

/** Antigravity's file is keyed by a name you choose, rather than by event. */
const ANTIGRAVITY_KEY = 'tokenistt';
/** Codex caps SessionEnd hooks at 3 seconds. */
const TIMEOUT: Record<string, number> = { 'codex:SessionEnd': 3 };

const isOurs = (command: unknown, agent: string): boolean => typeof command === 'string' && command.includes('tokenistt') && command.includes(` hook ${agent}`);

type HookEntry = { type?: string; command?: string; timeout?: number; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Settings;
  } catch {
    throw new CliError(`${file} is not valid JSON, so it was left alone.`, 1, 'Fix the file, then run this again.');
  }
}

function withoutOurs(settings: Settings, agent: string): Settings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept: HookGroup[] = [];
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) {
        kept.push(g);
        continue;
      }
      const remaining = g.hooks.filter((h) => !isOurs(h?.command, agent));
      if (remaining.length) kept.push({ ...g, hooks: remaining });
    }
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _dropped, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

function antigravityBlock(adapter: AgentAdapter, command: string): Record<string, unknown> {
  const handler = { type: 'command', command, timeout: 5 };
  const block: Record<string, unknown> = {};
  // Tool events take matcher groups; the others take handlers directly.
  for (const event of adapter.hookEvents) block[event] = event === 'PostToolUse' ? [{ matcher: '*', hooks: [handler] }] : [handler];
  return block;
}

function ownsAntigravityKey(settings: Settings, agent: string): boolean {
  const block = settings[ANTIGRAVITY_KEY];
  return !!block && JSON.stringify(block).includes(`hook ${agent}`);
}

function withoutOursAntigravity(settings: Settings, adapter: AgentAdapter): Settings {
  if (!(ANTIGRAVITY_KEY in settings)) return settings;
  // Someone else's hook group that happens to use this name is not ours to remove.
  if (!ownsAntigravityKey(settings, adapter.id)) throw new CliError(`The hook group "${ANTIGRAVITY_KEY}" in this file was not created by Tokenistt, so it was left alone.`, 1, 'Rename that group, then run this again.');
  const { [ANTIGRAVITY_KEY]: _ours, ...rest } = settings;
  return rest;
}

export function planConnect(adapter: AgentAdapter, target: HookTarget, command: string): { before: string; after: string; changed: boolean } {
  const current = readSettings(target.file);
  if (target.format === 'antigravity-json') {
    const clean = withoutOursAntigravity(current, adapter);
    const next = { ...clean, [ANTIGRAVITY_KEY]: antigravityBlock(adapter, command) };
    return { before: existsSync(target.file) ? readFileSync(target.file, 'utf8') : '', after: `${JSON.stringify(next, null, 2)}\n`, changed: JSON.stringify(current) !== JSON.stringify(next) };
  }
  const clean = withoutOurs(current, adapter.id);
  const hooks: Record<string, HookGroup[]> = { ...(clean.hooks ?? {}) };
  for (const event of adapter.hookEvents) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command, timeout: TIMEOUT[`${adapter.id}:${event}`] ?? 5 }] }];
  }
  const after = `${JSON.stringify({ ...clean, hooks }, null, 2)}\n`;
  const before = existsSync(target.file) ? readFileSync(target.file, 'utf8') : '';
  return { before, after, changed: JSON.stringify(current) !== JSON.stringify({ ...clean, hooks }) };
}

export function planDisconnect(adapter: AgentAdapter, target: HookTarget): { before: string; after: string; changed: boolean } {
  const current = readSettings(target.file);
  const clean = target.format === 'antigravity-json' ? (ownsAntigravityKey(current, adapter.id) ? withoutOursAntigravity(current, adapter) : current) : withoutOurs(current, adapter.id);
  const before = existsSync(target.file) ? readFileSync(target.file, 'utf8') : '';
  return { before, after: `${JSON.stringify(clean, null, 2)}\n`, changed: JSON.stringify(current) !== JSON.stringify(clean) };
}

export function isConnected(adapter: AgentAdapter, target: HookTarget): boolean {
  try {
    const settings = readSettings(target.file);
    if (target.format === 'antigravity-json') return ownsAntigravityKey(settings, adapter.id);
    const hooks = settings.hooks ?? {};
    return adapter.hookEvents.every((event) => hooks[event]?.some((g) => g.hooks?.some((h) => isOurs(h.command, adapter.id))));
  } catch {
    return false;
  }
}

/**
 * Writes atomically, after a backup, and returns the backup's path if there was anything to back up. A backup beside
 * a file inside the repository could be committed by accident, so `backupDir` lets it go somewhere ignored.
 */
export function applyPlan(target: HookTarget, after: string, now: Date = new Date(), backupDir?: string): string | undefined {
  mkdirSync(dirname(target.file), { recursive: true });
  let backup: string | undefined;
  if (existsSync(target.file)) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    if (backupDir) mkdirSync(backupDir, { recursive: true });
    backup = backupDir ? join(backupDir, `${basename(target.file)}.${stamp}`) : `${target.file}.tokenistt-backup-${stamp}`;
    copyFileSync(target.file, backup);
  }
  const tmp = `${target.file}.${process.pid}.tmp`;
  writeFileSync(tmp, after);
  renameSync(tmp, target.file);
  return backup;
}

/** A small line diff for the preview: common lines from both ends are skipped. */
export function previewDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const out: string[] = [];
  for (let i = start; i <= endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) out.push(`+ ${b[i]}`);
  return out.join('\n');
}
