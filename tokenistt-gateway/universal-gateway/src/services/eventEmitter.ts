import { EventEmitter } from 'node:events';
import { getRedisClient } from './redis.js';
import { forwardToClickHouse } from './clickhouse.js';

export interface TransactionEvent {
  requestId: string;
  traceId?: string;
  organizationId?: string | number | null;
  virtualKeyPublicId?: string;
  provider: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  latencyMs: number;
  status: 'success' | 'error' | 'timeout' | 'rate_limited' | 'throttled' | 'blocked' | string;
  costStatus?: 'ok' | 'COST_UNAVAILABLE';
  actor?: string;
  costCenter?: string;
  teamId?: string | number | null;
  projectId?: string | number | null;
  environment?: string;
  application?: string;
  timestamp: string;
}

export const localEventBus = new EventEmitter();
localEventBus.setMaxListeners(50);

let kafkaProducer: any = null;
let kafkaFailed = false;

/**
 * Emits transaction events asynchronously across:
 * 1. In-process local event bus (instant for test suites & in-memory listeners)
 * 2. Redis Stream / PubSub if Redis is connected
 * 3. Kafka topic 'tokenistt.transactions' if KAFKA_BROKERS is configured
 *
 * Never blocks gateway response or throws uncaught exceptions.
 */
export async function emitTransactionEvent(event: TransactionEvent): Promise<void> {
  try {
    // 1. Emit to local memory bus
    localEventBus.emit('transaction.completed', event);

    // 2. Publish to Redis Stream or PubSub if available
    const redis = getRedisClient();
    if (redis) {
      try {
        await redis.publish('tokenistt:events:transactions', JSON.stringify(event));
      } catch (err: any) {
        // Non-blocking log
        console.warn('[EventEmitter] Redis publish error:', err.message);
      }
    }

    // 3. Publish to Kafka if brokers configured
    if (process.env.KAFKA_BROKERS && !kafkaFailed) {
      try {
        if (!kafkaProducer) {
          // Dynamic import to prevent hard crash if kafkajs is not installed or brokers down
          const { Kafka } = await import('kafkajs');
          const brokers = process.env.KAFKA_BROKERS.split(',').map((b) => b.trim());
          const kafka = new Kafka({ clientId: 'tokenistt-gateway', brokers });
          kafkaProducer = kafka.producer();
          await kafkaProducer.connect();
        }

        await kafkaProducer.send({
          topic: 'tokenistt.transactions',
          messages: [{ key: event.requestId, value: JSON.stringify(event) }],
        });
      } catch (err: any) {
        console.warn('[EventEmitter] Kafka emit failed, continuing without Kafka:', err.message);
        kafkaFailed = true; // Avoid pounding an unreachable broker on every single request
      }
    }

    // 4. Dual-write to ClickHouse if enabled (asynchronous buffered batching)
    forwardToClickHouse(event).catch(() => {});
  } catch (err: any) {
    console.error('[EventEmitter] Unexpected error emitting transaction event:', err.message);
  }
}
