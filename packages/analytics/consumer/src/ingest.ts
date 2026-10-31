import { clickhouse, insertTransactions, toRow } from './clickhouse.js';
import type { RawTransactionRow, TransactionEvent } from './types.js';
import { config } from './config.js';

/**
 * Bounded in-memory buffer. The Kafka `eachMessage` handler pushes parsed
 * events here; a timer (or size threshold) flushes the buffer to ClickHouse
 * in a single batched insert. This keeps per-message overhead off the hot path.
 */
export class IngestBuffer {
  private buffer: RawTransactionRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private closed = false;

  constructor(
    private readonly batchSize = config.batchSize,
    private readonly flushMs = config.flushMs,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.flushMs);
    // Don't keep the event loop alive solely for the flush timer.
    this.timer.unref?.();
  }

  push(event: TransactionEvent): void {
    if (this.closed) return;
    this.buffer.push(toRow(event));
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await insertTransactions(batch);
    } catch (err) {
      // On failure, re-queue (bounded by memory; in prod route to a DLQ).
      console.error('[ingest] flush failed, re-queuing', (err as Error).message);
      this.buffer = batch.concat(this.buffer);
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await clickhouse.close();
  }
}
