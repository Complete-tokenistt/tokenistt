/**
 * Minimal, dependency-free typed event emitter.
 * Used both by the client (public events) and the cost tracker.
 */
export type EventListener<P> = (payload: P) => void;

export class Emitter<EventMap extends Record<string, any>> {
  private listeners: { [K in keyof EventMap]?: Set<EventListener<EventMap[K]>> } = {};

  on<K extends keyof EventMap>(event: K, listener: EventListener<EventMap[K]>): this {
    (this.listeners[event] ??= new Set<EventListener<EventMap[K]>>()).add(listener);
    return this;
  }

  once<K extends keyof EventMap>(event: K, listener: EventListener<EventMap[K]>): this {
    const wrap: EventListener<EventMap[K]> = (p) => {
      this.off(event, wrap);
      listener(p);
    };
    return this.on(event, wrap);
  }

  off<K extends keyof EventMap>(event: K, listener: EventListener<EventMap[K]>): this {
    this.listeners[event]?.delete(listener);
    return this;
  }

  protected emitEvent<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners[event];
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch (err) {
        // Never let a misbehaving listener break the request pipeline.
        // eslint-disable-next-line no-console
        console.error(`[Tokenistt] listener for "${String(event)}" threw`, err);
      }
    }
  }

  removeAllListeners(): this {
    this.listeners = {};
    return this;
  }
}
