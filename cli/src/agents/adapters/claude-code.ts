/**
 * Claude Code, through its documented lifecycle hooks: https://code.claude.com/docs/en/hooks
 * Hook input has no token counts, so usage comes from the transcript at the path the hook provides. That file's
 * format is not documented, so it is read defensively and labelled best-effort.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, UsageRecord } from '../adapter.js';
import { onPath } from '../detect.js';
import { deletedPaths, eventId, isTestCommand, repoPath, shapeCommand } from '../normalize.js';
import { EVENT_SCHEMA_VERSION, type AgentEvent, type NormalizeContext } from '../schemas.js';

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export const claudeCode: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  hookEvents: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd'],
  verification: 'live',
  capabilities: {
    sessions: { state: 'supported', how: 'SessionStart and SessionEnd hooks, with session_id' },
    tasks: { state: 'supported', how: 'UserPromptSubmit and Stop hooks. The prompt text is not stored unless privacy.capturePrompts is on' },
    files: { state: 'supported', how: 'PostToolUse on Read, Write and Edit. Deletions only from plain rm or git rm commands' },
    commands: { state: 'supported', how: 'PostToolUse on Bash. Program and subcommand only by default' },
    tools: { state: 'supported', how: 'PostToolUse, by tool name' },
    errors: { state: 'supported', how: 'PostToolUseFailure and StopFailure. The error text is not stored' },
    tests: { state: 'best-effort', how: 'Recognised from common test commands; pass or fail is whether the command failed' },
    model: { state: 'best-effort', how: 'SessionStart model field, which is optional, then the transcript' },
    tokens: { state: 'best-effort', how: 'Read from the transcript path the hook provides. The format is undocumented, so tokens show as unknown if it changes' },
    cost: { state: 'best-effort', how: 'Estimated from tokens and the catalog price. On a subscription this is not what you paid' },
    context: { state: 'supported', how: 'SessionStart additionalContext' },
  },
  detectInstallation(env, home) {
    const bin = onPath('claude', env);
    if (bin) return { installed: true, evidence: bin };
    const dir = join(home, '.claude');
    return existsSync(dir) ? { installed: true, evidence: dir } : { installed: false };
  },
  hookTargets(root, home) {
    return [
      // settings.local.json is git-ignored by Claude Code, so a machine-specific path stays out of the repository.
      { scope: 'project', file: join(root, '.claude', 'settings.local.json'), format: 'claude-json' },
      { scope: 'user', file: join(home, '.claude', 'settings.json'), format: 'claude-json' },
    ];
  },
  normalizeEvent(input, ctx) {
    return normalizeClaude(input, ctx);
  },
  collectUsage: parseClaudeTranscript,
};

function normalizeClaude(input: Record<string, unknown>, ctx: NormalizeContext): AgentEvent[] {
  const session = str(input.session_id);
  const hook = str(input.hook_event_name);
  if (!session || !hook) return [];
  const cwd = str(input.cwd);
  const toolUse = str(input.tool_use_id);
  const second = Math.floor(ctx.now.getTime() / 1000);
  // On every event: hooks connected mid-session never see SessionStart, and a long turn may not reach Stop for a while.
  const transcript = str(input.transcript_path);
  const base = (type: AgentEvent['type'], key: string | undefined): AgentEvent => ({
    v: EVENT_SCHEMA_VERSION,
    // Hook input has no timestamp; the second keeps a double delivery together but separates real repeats.
    id: eventId(['claude-code', session, hook, type, key ?? toolUse ?? str(input.prompt_id), toolUse ? undefined : second]),
    agent: 'claude-code',
    session,
    type,
    at: ctx.now.toISOString(),
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    ...(transcript ? { transcript } : {}),
  });

  switch (hook) {
    case 'SessionStart': {
      const source = str(input.source) ?? 'startup';
      // Compaction and /clear continue the same session; they are not a new start.
      if (source === 'compact' || source === 'clear') return [];
      const e = base(source === 'resume' || source === 'fork' ? 'SESSION_RESUMED' : 'SESSION_STARTED', source);
      e.reason = source;
      const model = str(input.model);
      if (model) e.model = model;
      return [e];
    }
    case 'UserPromptSubmit': {
      const e = base('TASK_STARTED', undefined);
      const prompt = str(input.prompt);
      if (ctx.privacy.capturePrompts && prompt) e.task = prompt.slice(0, 500);
      return [e];
    }
    case 'Stop':
      return [base('TASK_COMPLETED', undefined)];
    case 'StopFailure': {
      const e = base('ERROR_OCCURRED', undefined);
      e.ok = false;
      return [e];
    }
    case 'SessionEnd': {
      const e = base('SESSION_ENDED', undefined);
      const reason = str(input.reason);
      if (reason) e.reason = reason.slice(0, 40);
      return [e];
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return toolEvents(input, ctx, hook === 'PostToolUse', base, cwd);
    default:
      return [];
  }
}

function toolEvents(
  input: Record<string, unknown>,
  ctx: NormalizeContext,
  ok: boolean,
  base: (type: AgentEvent['type'], key: string | undefined) => AgentEvent,
  cwd: string | undefined,
): AgentEvent[] {
  const tool = str(input.tool_name);
  if (!tool) return [];
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const response = (input.tool_response ?? {}) as Record<string, unknown>;

  if (!ok) {
    const e = base(tool === 'Bash' && isTestCommand(toolInput.command) ? 'TEST_EXECUTED' : 'ERROR_OCCURRED', undefined);
    e.tool = tool;
    e.ok = false;
    if (tool === 'Bash') {
      const command = shapeCommand(toolInput.command, ctx.privacy.commands);
      if (command) e.command = command;
    }
    return [e];
  }

  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const path = repoPath(ctx.root, cwd, toolInput.file_path ?? toolInput.notebook_path);
    const type = READ_TOOLS.has(tool) ? 'FILE_READ' : response.type === 'create' ? 'FILE_CREATED' : 'FILE_MODIFIED';
    const e = base(type, undefined);
    e.tool = tool;
    if (path) e.path = path;
    return [e];
  }

  if (tool === 'Bash') {
    const raw = toolInput.command;
    const e = base(isTestCommand(raw) ? 'TEST_EXECUTED' : 'COMMAND_EXECUTED', undefined);
    e.tool = tool;
    e.ok = response.interrupted !== true;
    const command = shapeCommand(raw, ctx.privacy.commands);
    if (command) e.command = command;
    const out = [e];
    deletedPaths(raw).forEach((p, i) => {
      const path = repoPath(ctx.root, cwd, p);
      if (!path) return;
      const del = base('FILE_DELETED', `${str(input.tool_use_id) ?? ''}:${i}`);
      del.tool = tool;
      del.path = path;
      out.push(del);
    });
    return out;
  }

  const e = base('TOOL_INVOKED', undefined);
  e.tool = tool;
  return [e];
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * One assistant turn appears on several lines while it streams, all with the same request id and the usage so far.
 * Keeping the last line per request gives each call's final numbers. Anything unrecognised is skipped.
 */
export function parseClaudeTranscript(text: string): UsageRecord[] {
  const byRequest = new Map<string, UsageRecord>();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let row: { type?: unknown; requestId?: unknown; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const usage = row.message?.usage;
    if (row.type !== 'assistant' || !usage || typeof usage !== 'object') continue;
    const requestId = str(row.requestId) ?? str(row.message?.id);
    if (!requestId) continue;
    const model = str(row.message?.model);
    byRequest.set(requestId, {
      requestId,
      ...(model && model !== '<synthetic>' ? { model } : {}),
      ...(str(row.timestamp) ? { at: str(row.timestamp) } : {}),
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheCreationTokens: count(usage.cache_creation_input_tokens),
    });
  }
  return [...byRequest.values()];
}
