import { Stream } from '../core/stream';
import type { Tokenistt } from '../client';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionChoice,
  ChatCompletionMessage,
  ToolCall,
  Usage,
} from '../types';

export interface CostMeta {
  model: string;
  user?: string;
  costCenter?: string;
  requestId?: string;
}

/**
 * Stream of `ChatCompletionChunk`s that also reconstructs the full
 * `ChatCompletion` via `finalChatCompletion()` — mirroring the OpenAI SDK.
 *
 * Cost tracking fires automatically once the stream ends (the gateway is
 * asked to include usage via `stream_options.include_usage`).
 */
export class ChatCompletionStream extends Stream<ChatCompletionChunk> {
  #accumulated: ChatCompletionChunk[] = [];
  #finalUsage: Usage | undefined;
  #done: Promise<void>;

  constructor(
    response: Response,
    private clientRef: Tokenistt,
    private meta: CostMeta,
  ) {
    super(response, (line) => {
      try {
        return JSON.parse(line) as ChatCompletionChunk;
      } catch {
        return null;
      }
    });

    this.#done = this.accumulate((chunk) => {
      this.#accumulated.push(chunk);
      if (chunk.usage) this.#finalUsage = chunk.usage;
    }).then(() => {
      this.clientRef.recordUsage(this.#finalUsage, {
        model: this.meta.model,
        user: this.meta.user,
        costCenter: this.meta.costCenter,
        requestId: this.meta.requestId,
      });
    });
  }

  async finalChatCompletion(): Promise<ChatCompletion> {
    await this.#done;
    return buildChatCompletion(this.#accumulated, this.#finalUsage);
  }
}

/** Reconstruct a `ChatCompletion` from an ordered list of chunks. */
export function buildChatCompletion(
  chunks: ChatCompletionChunk[],
  usage?: Usage | null,
): ChatCompletion {
  const first = chunks[0];
  const last = chunks[chunks.length - 1];

  let maxIndex = -1;
  for (const c of chunks) {
    for (const ch of c.choices ?? []) {
      if (ch.index > maxIndex) maxIndex = ch.index;
    }
  }

  const choices: ChatCompletionChoice[] = [];
  for (let i = 0; i <= maxIndex; i++) {
    const message: ChatCompletionMessage = {
      role: 'assistant',
      content: null,
      refusal: null,
      tool_calls: [] as ToolCall[],
      function_call: null,
    };
    let finishReason: ChatCompletionChoice['finish_reason'] = null;
    let logprobs: ChatCompletionChoice['logprobs'] = null;

    for (const c of chunks) {
      const ch = (c.choices ?? []).find((x) => x.index === i);
      if (!ch) continue;
      const d = ch.delta;

      if (d.role) message.role = d.role as 'assistant';
      if (d.content) message.content = (message.content ?? '') + d.content;
      if (d.refusal) message.refusal = (message.refusal ?? '') + d.refusal;
      if (d.function_call) {
        message.function_call = message.function_call ?? { name: '', arguments: '' };
        if (d.function_call.name) message.function_call.name += d.function_call.name;
        if (d.function_call.arguments)
          message.function_call.arguments += d.function_call.arguments;
      }
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const existing = (message.tool_calls as ToolCall[])[tc.index];
          if (!existing) {
            (message.tool_calls as ToolCall[])[tc.index] = {
              id: tc.id ?? '',
              type: 'function',
              function: {
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              },
            };
          } else {
            if (tc.id) existing.id += tc.id;
            if (tc.function?.name) existing.function.name += tc.function.name;
            if (tc.function?.arguments)
              existing.function.arguments += tc.function.arguments;
          }
        }
      }
      if (ch.finish_reason) finishReason = ch.finish_reason;
      if (ch.logprobs) logprobs = ch.logprobs;
    }

    if ((message.tool_calls as ToolCall[]).length === 0) message.tool_calls = null;

    choices.push({ index: i, message, finish_reason: finishReason, logprobs });
  }

  return {
    id: first?.id ?? '',
    object: 'chat.completion',
    created: first?.created ?? Math.floor(Date.now() / 1000),
    model: first?.model ?? '',
    system_fingerprint: last?.system_fingerprint ?? first?.system_fingerprint,
    choices,
    usage: usage ?? null,
  };
}
