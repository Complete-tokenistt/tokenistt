/** The agents Tokenistt knows about. Adding one means writing an adapter and listing it here. */
import { UsageError } from '../core/errors.js';
import type { AgentAdapter } from './adapter.js';
import { claudeCode } from './adapters/claude-code.js';

export const ADAPTERS: AgentAdapter[] = [claudeCode];

export function adapterFor(id: string): AgentAdapter {
  const found = ADAPTERS.find((a) => a.id === id || a.id.split('-')[0] === id);
  if (!found) throw new UsageError(`Unknown agent "${id}".`, `Supported: ${ADAPTERS.map((a) => a.id).join(', ')}.`);
  return found;
}
