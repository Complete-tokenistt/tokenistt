/**
 * Re-indexes when files change. Bursts are debounced, and a change that arrives during a run schedules exactly
 * one more, so a save during indexing is never lost and runs never overlap.
 */
import { watch, type FSWatcher } from 'node:fs';
import { createExcluder } from './exclude.js';

export interface WatchOptions {
  root: string;
  exclude?: string[];
  debounceMs?: number;
  onChange: (changed: string[]) => Promise<void>;
  onError?: (err: unknown) => void;
}

export interface WatchHandle {
  close(): void;
  /** Resolves when no run is active or pending. */
  idle(): Promise<void>;
}

export function watchFiles(opts: WatchOptions): WatchHandle {
  const excluded = createExcluder(opts.exclude);
  const debounceMs = opts.debounceMs ?? 300;
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let closed = false;

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  };
  const run = (): void => {
    timer = undefined;
    if (running || closed || pending.size === 0) return;
    const changed = [...pending].sort();
    pending = new Set();
    running = opts.onChange(changed)
      .catch((err: unknown) => opts.onError?.(err))
      .finally(() => {
        running = undefined;
        if (pending.size > 0 && !closed) schedule();
      });
  };

  const watcher: FSWatcher = watch(opts.root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const path = String(filename).replace(/\\/g, '/');
    if (excluded(path)) return;
    pending.add(path);
    if (!running) schedule();
  });
  watcher.on('error', (err) => opts.onError?.(err));

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      watcher.close();
    },
    async idle() {
      while (running || timer) {
        if (running) await running;
        else await new Promise((r) => setTimeout(r, debounceMs));
      }
    },
  };
}
