/**
 * services/promptCompression.ts — conservative, meaning-preserving prompt shrinking.
 * Opt-in per request (`x-tokenistt-compress: true`). Fenced code blocks are never touched.
 *
 *  - collapses runs of spaces/tabs and 3+ blank lines in prose
 *  - trims message edges
 *  - drops a message that exactly repeats the one before it (same role + content)
 */
import type { OpenAIMessage } from '../types/index.js';

export interface CompressionResult {
  messages: OpenAIMessage[];
  savedChars: number;
}

const FENCE = /(```[\s\S]*?```)/g;

function squeezeProse(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function compressText(text: string): string {
  return text
    .split(FENCE)
    .map((part, i) => (i % 2 === 1 ? part : squeezeProse(part)))
    .join('')
    .trim();
}

const totalChars = (ms: OpenAIMessage[]) =>
  ms.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);

export function compressMessages(messages: OpenAIMessage[]): CompressionResult {
  const before = totalChars(messages);
  const out: OpenAIMessage[] = [];

  for (const m of messages) {
    if (typeof m.content !== 'string') {
      out.push(m);
      continue;
    }
    const content = compressText(m.content);
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && prev.content === content && !m.tool_calls && !m.tool_call_id) continue;
    out.push({ ...m, content });
  }

  return { messages: out, savedChars: Math.max(0, before - totalChars(out)) };
}
