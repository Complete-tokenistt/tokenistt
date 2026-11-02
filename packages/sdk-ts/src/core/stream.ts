import { Emitter } from './emitter';

/**
 * Generic Server-Sent-Events stream reader.
 *
 * Wraps a `fetch` `Response` and exposes an async-iterable of parsed `data:`
 * payloads. The underlying body is *tee'd* so that the consumer-facing
 * iterator and an internal accumulator can read independently — this lets
 * `ChatCompletionStream.finalChatCompletion()` work whether or not the caller
 * manually iterates the chunks.
 */

export class Stream<T>
  extends Emitter<{ abort: undefined; final: T | undefined; error: unknown }>
  implements AsyncIterable<T>
{
  protected userStream: ReadableStream<Uint8Array>;
  protected accStream: ReadableStream<Uint8Array>;

  constructor(
    protected response: Response,
    protected parse: (data: string) => T | null,
  ) {
    super();
    const body = response.body;
    if (!body) {
      // No body (e.g. empty response) — produce inert streams.
      const empty = () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        });
      this.userStream = empty();
      this.accStream = empty();
    } else {
      const [a, b] = body.tee();
      this.userStream = a;
      this.accStream = b;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.#iterate(this.userStream);
  }

  #iterate(stream: ReadableStream<Uint8Array>): AsyncIterator<T> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const self = this;
    let buffer = '';
    const pending: string[] = []; // complete events from a read that carried more than one

    return {
      async next(): Promise<IteratorResult<T>> {
        try {
          while (true) {
            while (pending.length) {
              const ev = pending.shift() as string;
              if (ev === '[DONE]') return { done: true, value: undefined };
              const parsed = self.parse(ev);
              if (parsed != null) return { done: false, value: parsed };
            }
            const { done, value } = await reader.read();
            if (done) {
              const rem = buffer.trim();
              buffer = '';
              if (rem) {
                const parsed = self.parse(rem);
                if (parsed != null) return { done: false, value: parsed };
              }
              return { done: true, value: undefined };
            }
            buffer += decoder.decode(value, { stream: true });
            const { events, remainder } = splitSSE(buffer);
            buffer = remainder;
            pending.push(...events);
          }
        } catch (err) {
          self.emitEvent('error', err);
          throw err;
        }
      },
      async return(): Promise<IteratorResult<T>> {
        await reader.cancel().catch(() => undefined);
        return { done: true, value: undefined };
      },
    };
  }

  /**
   * Drive the accumulator stream, invoking `consume` for each parsed chunk.
   * Resolves when the stream is fully read.
   */
  protected accumulate(consume: (chunk: T) => void): Promise<void> {
    const self = this;
    return (async () => {
      try {
        const it = self.#iterate(self.accStream);
        while (true) {
          const { done, value } = await it.next();
          if (done) break;
          consume(value as T);
        }
      } catch {
        // Aborts / connection resets on the accumulator are non-fatal.
      }
    })();
  }

  abort(): void {
    this.userStream.getReader().cancel().catch(() => undefined);
    this.accStream.getReader().cancel().catch(() => undefined);
    this.emitEvent('abort', undefined);
  }

  async finalResponse(): Promise<Response> {
    return this.response;
  }
}

/**
 * Split a (possibly partial) SSE buffer into complete event payloads.
 * Returns the data payloads found and the remaining unterminated buffer.
 */
export function splitSSE(buffer: string): { events: string[]; remainder: string } {
  const blocks = buffer.split('\n\n');
  const remainder = blocks.pop() ?? '';
  const events: string[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    let data = '';
    for (const line of lines) {
      if (line.startsWith('data:')) {
        // Strip the "data:" prefix and a single leading space.
        data += line.slice(5).replace(/^ /, '') + '\n';
      }
    }
    const trimmed = data.replace(/\n$/, '');
    if (trimmed.length > 0) events.push(trimmed);
  }

  return { events, remainder };
}
