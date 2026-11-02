/**
 * What an agent integration provides. Only agent-specific knowledge lives here: how to detect it, how to install
 * hooks through its own documented config, and how to read its events. Session discovery, history and live
 * subscription work from the normalized events, so they are shared (see session-manager.ts).
 */
import type { AgentEvent, AgentId, Capability, CapabilityKey, NormalizeContext } from './schemas.js';

export interface Installation {
  installed: boolean;
  /** How it was found: a binary on PATH or its config directory. */
  evidence?: string;
}

/** A place an agent reads hook configuration from. */
export interface HookTarget {
  scope: 'project' | 'user';
  file: string;
  /** The file's current text, or undefined if it does not exist. */
  format: 'claude-json' | 'codex-json' | 'antigravity-json';
}

export interface UsageRecord {
  /** Unique per API call, so a transcript read twice does not count twice. */
  requestId: string;
  model?: string;
  at?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** The agent's own estimate, if it reports one. */
  costUsd?: number;
}

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  /** Which hook events to subscribe to in the agent's config. */
  hookEvents: string[];
  detectInstallation(env: NodeJS.ProcessEnv, home: string): Installation;
  capabilities: Record<CapabilityKey, Capability>;
  /** Whether the capability table has been checked against the real agent, or only its documentation. */
  verification: 'live' | 'documented';
  hookTargets(root: string, home: string): HookTarget[];
  /** Returns nothing for hook events that carry no information we keep. */
  normalizeEvent(input: Record<string, unknown>, ctx: NormalizeContext): AgentEvent[];
  /** The working directory, for agents that do not send a plain `cwd`. */
  hookCwd?(input: Record<string, unknown>): string | undefined;
  /** Anything the user still has to do after connecting. */
  afterConnect?: string;
  /** Reads usage from a transcript the agent pointed us at. Unknown shapes yield nothing rather than wrong numbers. */
  collectUsage?(text: string): UsageRecord[];
}
