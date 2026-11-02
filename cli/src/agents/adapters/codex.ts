/**
 * OpenAI Codex, through its documented hooks: https://learn.chatgpt.com/docs/hooks.md
 * Its hook input resembles Claude Code's, but file edits arrive as patch text, and hook input has no token counts.
 * The transcript format is undocumented and could not be checked here, so tokens are reported as unknown rather
 * than parsed from a guessed shape.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from '../adapter.js';
import { onPath } from '../detect.js';
import { deletedPaths, eventId, isTestCommand, repoPath, shapeCommand } from '../normalize.js';
import { EVENT_SCHEMA_VERSION, type AgentEvent, type NormalizeContext } from '../schemas.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Only the header lines of a patch are read: the file names. The changed lines themselves are never kept. */
export function patchTargets(patch: unknown): Array<{ path: string; action: 'add' | 'update' | 'delete' }> {
  if (typeof patch !== 'string') return [];
  const out: Array<{ path: string; action: 'add' | 'update' | 'delete' }> = [];
  for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    out.push({ path: (m[2] ?? '').trim(), action: m[1] === 'Add' ? 'add' : m[1] === 'Delete' ? 'delete' : 'update' });
  }
  return out;
}

export const codex: AgentAdapter = {
  id: 'codex',
  displayName: 'OpenAI Codex',
  hookEvents: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'],
  verification: 'documented',
  afterConnect: 'Codex runs a new hook only after you trust it: open Codex and review it with /hooks. A project hook also needs the project trusted. This file holds absolute paths for this machine, so do not commit it.',
  capabilities: {
    sessions: { state: 'supported', how: 'SessionStart and SessionEnd hooks, with session_id' },
    tasks: { state: 'supported', how: 'UserPromptSubmit and Stop hooks. The prompt text is not stored unless privacy.capturePrompts is on' },
    files: { state: 'best-effort', how: 'File names from apply_patch headers. Reads are not reported, because Codex reads files through shell commands' },
    commands: { state: 'supported', how: 'PostToolUse on Bash. Program and subcommand only by default' },
    tools: { state: 'supported', how: 'PostToolUse, by tool name. Hosted tools such as web search are not reported' },
    errors: { state: 'unsupported', how: 'Hook input does not separate a failed command from a successful one' },
    tests: { state: 'best-effort', how: 'Recognised from common test commands. Pass or fail is not known' },
    model: { state: 'supported', how: 'The model field on every hook event' },
    tokens: { state: 'unsupported', how: 'Hook input has no token counts and the transcript format is undocumented, so tokens show as unknown' },
    cost: { state: 'unsupported', how: 'Needs token counts, so cost shows as unknown' },
    context: { state: 'supported', how: 'SessionStart additionalContext, and project instructions in AGENTS.md' },
  },
  detectInstallation(env, home) {
    const bin = onPath('codex', env);
    if (bin) return { installed: true, evidence: bin };
    const dir = join(home, '.codex');
    return existsSync(dir) ? { installed: true, evidence: dir } : { installed: false };
  },
  hookTargets(root, home) {
    return [
      { scope: 'project', file: join(root, '.codex', 'hooks.json'), format: 'codex-json' },
      { scope: 'user', file: join(home, '.codex', 'hooks.json'), format: 'codex-json' },
    ];
  },
  normalizeEvent(input, ctx) {
    return normalizeCodex(input, ctx);
  },
};

function normalizeCodex(input: Record<string, unknown>, ctx: NormalizeContext): AgentEvent[] {
  const session = str(input.session_id);
  const hook = str(input.hook_event_name);
  if (!session || !hook) return [];
  const cwd = str(input.cwd);
  const model = str(input.model);
  const toolUse = str(input.tool_use_id);
  const turn = str(input.turn_id);
  const second = Math.floor(ctx.now.getTime() / 1000);
  const base = (type: AgentEvent['type'], key?: string): AgentEvent => ({
    v: EVENT_SCHEMA_VERSION,
    id: eventId(['codex', session, hook, type, key ?? toolUse ?? turn, toolUse || turn ? undefined : second]),
    agent: 'codex',
    session,
    type,
    at: ctx.now.toISOString(),
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    ...(model ? { model } : {}),
  });

  switch (hook) {
    case 'SessionStart': {
      const source = str(input.source) ?? 'startup';
      if (source === 'compact' || source === 'clear') return [];
      const e = base(source === 'resume' || source === 'fork' ? 'SESSION_RESUMED' : 'SESSION_STARTED', source);
      e.reason = source;
      return [e];
    }
    case 'UserPromptSubmit': {
      const e = base('TASK_STARTED');
      const prompt = str(input.prompt);
      if (ctx.privacy.capturePrompts && prompt) e.task = prompt.slice(0, 500);
      return [e];
    }
    case 'Stop':
      return [base('TASK_COMPLETED')];
    case 'SessionEnd':
      return [base('SESSION_ENDED')];
    case 'PostToolUse':
      return toolEvents(input, ctx, base, cwd);
    default:
      return [];
  }
}

function toolEvents(input: Record<string, unknown>, ctx: NormalizeContext, base: (type: AgentEvent['type'], key?: string) => AgentEvent, cwd: string | undefined): AgentEvent[] {
  const tool = str(input.tool_name);
  if (!tool) return [];
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const toolUse = str(input.tool_use_id) ?? '';

  if (tool === 'apply_patch') {
    const out: AgentEvent[] = [];
    patchTargets(toolInput.command).forEach((t, i) => {
      const e = base(t.action === 'add' ? 'FILE_CREATED' : t.action === 'delete' ? 'FILE_DELETED' : 'FILE_MODIFIED', `${toolUse}:${i}`);
      e.tool = tool;
      const path = repoPath(ctx.root, cwd, t.path);
      if (path) e.path = path;
      out.push(e);
    });
    return out.length ? out : [Object.assign(base('TOOL_INVOKED'), { tool })];
  }
  if (tool === 'Bash') {
    const raw = toolInput.command;
    // PostToolUse also fires after a non-zero exit, so success cannot be inferred: `ok` stays unset.
    const e = base(isTestCommand(raw) ? 'TEST_EXECUTED' : 'COMMAND_EXECUTED');
    e.tool = tool;
    const command = shapeCommand(raw, ctx.privacy.commands);
    if (command) e.command = command;
    const out = [e];
    deletedPaths(raw).forEach((p, i) => {
      const path = repoPath(ctx.root, cwd, p);
      if (!path) return;
      const del = base('FILE_DELETED', `${toolUse}:${i}`);
      del.tool = tool;
      del.path = path;
      out.push(del);
    });
    return out;
  }
  const e = base('TOOL_INVOKED');
  e.tool = tool;
  return [e];
}
