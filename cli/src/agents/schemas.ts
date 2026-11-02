/**
 * The normalized event every agent adapter produces. Fields are an allowlist: prompts, file contents, tool output and
 * error text have no place here, so they cannot be stored by accident, whatever an agent sends.
 */
export const EVENT_SCHEMA_VERSION = 1;

export type EventType =
  | 'SESSION_STARTED' | 'SESSION_RESUMED' | 'TASK_STARTED' | 'FILE_READ' | 'FILE_CREATED' | 'FILE_MODIFIED' | 'FILE_DELETED'
  | 'COMMAND_EXECUTED' | 'TOOL_INVOKED' | 'ERROR_OCCURRED' | 'TEST_EXECUTED' | 'TASK_COMPLETED' | 'SESSION_ENDED';

export type AgentId = 'claude-code' | 'codex' | 'antigravity';

export interface AgentEvent {
  v: number;
  /** Deterministic, so the same hook delivered twice is stored once. */
  id: string;
  agent: AgentId;
  session: string;
  type: EventType;
  at: string;
  branch?: string;
  model?: string;
  tool?: string;
  /** Repo-relative. Paths outside the repository are dropped. */
  path?: string;
  /** Shaped by privacy.commands. */
  command?: string;
  ok?: boolean;
  /** Why a session ended or started: a short value from the agent, never free text from the user. */
  reason?: string;
  /** Local path the agent gave us for reading usage. Never synced. */
  transcript?: string;
  /** Only with privacy.capturePrompts. */
  task?: string;
}

export type CommandPrivacy = 'none' | 'name' | 'redacted';

export interface NormalizeContext {
  root: string;
  branch?: string;
  now: Date;
  privacy: { commands: CommandPrivacy; capturePrompts: boolean };
}

export type CapabilityState = 'supported' | 'best-effort' | 'unsupported';

export interface Capability {
  state: CapabilityState;
  /** How it works, or why it does not. */
  how: string;
}

export const CAPABILITY_KEYS = ['sessions', 'tasks', 'files', 'commands', 'tools', 'errors', 'tests', 'model', 'tokens', 'cost', 'context'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
