/**
 * Google Antigravity, through its documented hooks: https://antigravity.google/docs/hooks
 * Its local conversation databases and protobuf files are private to the app and are never read. Hook input has no
 * token counts and no session-end event, so tokens are unknown and sessions end only by going quiet.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from '../adapter.js';
import { onPath } from '../detect.js';
import { deletedPaths, eventId, isTestCommand, repoPath, shapeCommand } from '../normalize.js';
import { EVENT_SCHEMA_VERSION, type AgentEvent, type NormalizeContext } from '../schemas.js';

const READ_TOOLS: Record<string, string> = { view_file: 'AbsolutePath' };
const WRITE_TOOLS: Record<string, string> = { write_to_file: 'TargetFile', replace_file_content: 'TargetFile', multi_replace_file_content: 'TargetFile' };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): string | undefined => (typeof v === 'number' ? String(v) : undefined);

function firstWorkspace(input: Record<string, unknown>): string | undefined {
  const paths = input.workspacePaths;
  return Array.isArray(paths) ? paths.find((p): p is string => typeof p === 'string' && !!p) : undefined;
}

export const antigravity: AgentAdapter = {
  id: 'antigravity',
  displayName: 'Google Antigravity',
  hookEvents: ['SessionStart', 'PreInvocation', 'PostToolUse', 'Stop'],
  verification: 'documented',
  afterConnect: 'Start a new Antigravity conversation for the hooks to take effect. This file holds absolute paths for this machine, so do not commit it.',
  capabilities: {
    sessions: { state: 'best-effort', how: 'SessionStart hook, with conversationId. There is no end event, so a session is treated as over once it goes quiet' },
    tasks: { state: 'supported', how: 'PreInvocation and Stop hooks. The prompt text is not stored unless privacy.capturePrompts is on' },
    files: { state: 'supported', how: 'PostToolUse on view_file, write_to_file and the replace tools. Deletions only from plain rm or git rm commands' },
    commands: { state: 'supported', how: 'PostToolUse on run_command. Program and subcommand only by default' },
    tools: { state: 'supported', how: 'PostToolUse, by tool name' },
    errors: { state: 'supported', how: 'The error field on PostToolUse and Stop. The error text is not stored' },
    tests: { state: 'best-effort', how: 'Recognised from common test commands; pass or fail is whether the tool call reported an error' },
    model: { state: 'supported', how: 'The modelName field on every hook event' },
    tokens: { state: 'unsupported', how: 'Not in hook input, and the transcript format is undocumented, so tokens show as unknown' },
    cost: { state: 'unsupported', how: 'Needs token counts, so cost shows as unknown' },
    context: { state: 'supported', how: 'Rule files in .agents/rules, and SessionStart injectSteps' },
  },
  detectInstallation(env, home) {
    const bin = onPath('antigravity', env) ?? onPath('agy', env);
    if (bin) return { installed: true, evidence: bin };
    const dir = join(home, '.gemini', 'antigravity');
    return existsSync(dir) ? { installed: true, evidence: dir } : { installed: false };
  },
  hookTargets(root, home) {
    return [
      { scope: 'project', file: join(root, '.agents', 'hooks.json'), format: 'antigravity-json' },
      { scope: 'user', file: join(home, '.gemini', 'config', 'hooks.json'), format: 'antigravity-json' },
    ];
  },
  hookCwd: firstWorkspace,
  normalizeEvent(input, ctx) {
    return normalizeAntigravity(input, ctx);
  },
};

function normalizeAntigravity(input: Record<string, unknown>, ctx: NormalizeContext): AgentEvent[] {
  const session = str(input.conversationId);
  // Hook input names no event, so each subscription passes it on the command line, read here as `hook_event_name`.
  const hook = str(input.hook_event_name) ?? inferEvent(input);
  if (!session || !hook) return [];
  const model = str(input.modelName);
  const step = num(input.stepIdx) ?? num(input.invocationNum) ?? num(input.executionNum);
  const second = Math.floor(ctx.now.getTime() / 1000);
  const base = (type: AgentEvent['type'], key?: string): AgentEvent => ({
    v: EVENT_SCHEMA_VERSION,
    id: eventId(['antigravity', session, hook, type, key ?? step, step || key ? undefined : second]),
    agent: 'antigravity',
    session,
    type,
    at: ctx.now.toISOString(),
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    ...(model ? { model } : {}),
  });

  switch (hook) {
    case 'SessionStart':
      return [base('SESSION_STARTED')];
    case 'PreInvocation': {
      const e = base('TASK_STARTED');
      const prompt = str(input.lastUserInput);
      if (ctx.privacy.capturePrompts && prompt) e.task = prompt.slice(0, 500);
      return [e];
    }
    case 'Stop': {
      if (input.error) {
        const e = base('ERROR_OCCURRED');
        e.ok = false;
        return [e];
      }
      const e = base('TASK_COMPLETED');
      const reason = str(input.terminationReason);
      if (reason) e.reason = reason.slice(0, 40);
      return [e];
    }
    case 'PostToolUse':
      return toolEvents(input, ctx, base, firstWorkspace(input));
    default:
      return [];
  }
}

/** Antigravity's input does not say which hook fired, but each event's documented fields are distinct. */
function inferEvent(input: Record<string, unknown>): string | undefined {
  if (input.toolCall && typeof input.toolCall === 'object') return 'PostToolUse';
  if (input.terminationReason !== undefined || input.executionNum !== undefined || input.fullyIdle !== undefined) return 'Stop';
  if (input.invocationNum !== undefined) return 'PreInvocation';
  if (input.conversationId !== undefined) return 'SessionStart';
  return undefined;
}

function toolEvents(input: Record<string, unknown>, ctx: NormalizeContext, base: (type: AgentEvent['type'], key?: string) => AgentEvent, cwd: string | undefined): AgentEvent[] {
  const call = input.toolCall as { name?: unknown; args?: Record<string, unknown> } | undefined;
  const tool = str(call?.name);
  if (!tool) return [];
  const args = call?.args ?? {};
  const failed = !!input.error;

  const readKey = READ_TOOLS[tool];
  const writeKey = WRITE_TOOLS[tool];
  if ((readKey || writeKey) && !failed) {
    const type = readKey ? 'FILE_READ' : tool === 'write_to_file' && args.Overwrite !== true ? 'FILE_CREATED' : 'FILE_MODIFIED';
    const e = base(type);
    e.tool = tool;
    const path = repoPath(ctx.root, cwd, args[readKey ?? writeKey ?? '']);
    if (path) e.path = path;
    return [e];
  }
  if (tool === 'run_command') {
    const raw = args.CommandLine;
    const commandCwd = str(args.Cwd) ?? cwd;
    const e = base(isTestCommand(raw) ? 'TEST_EXECUTED' : failed ? 'ERROR_OCCURRED' : 'COMMAND_EXECUTED');
    e.tool = tool;
    e.ok = !failed;
    const command = shapeCommand(raw, ctx.privacy.commands);
    if (command) e.command = command;
    const out = [e];
    if (!failed) {
      deletedPaths(raw).forEach((p, i) => {
        const path = repoPath(ctx.root, commandCwd, p);
        if (!path) return;
        const del = base('FILE_DELETED', `del:${String(input.stepIdx ?? '')}:${i}`);
        del.tool = tool;
        del.path = path;
        out.push(del);
      });
    }
    return out;
  }
  const e = base(failed ? 'ERROR_OCCURRED' : 'TOOL_INVOKED');
  e.tool = tool;
  if (failed) e.ok = false;
  return [e];
}
