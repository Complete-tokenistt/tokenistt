import { Kafka, Consumer, logLevel, type EachMessagePayload } from 'kafkajs';
import { config } from './config.js';
import type { TransactionEvent } from './types.js';
import type { IngestBuffer } from './ingest.js';

/** Connect a Kafka consumer, route each message into the ingest buffer. */
export async function startConsumer(buffer: IngestBuffer): Promise<Consumer> {
  const kafka = new Kafka({
    brokers: config.kafkaBrokers,
    logLevel: logLevel.WARN,
    retry: { retries: 5, initialRetryTime: 300 },
  });

  const consumer = kafka.consumer({
    groupId: config.kafkaGroup,
    sessionTimeout: 30_000,
  });

  await consumer.connect();
  await consumer.subscribe({ topic: config.kafkaTopic, fromOffset: 'latest' });

  await consumer.run({
    eachMessage: async (payload: EachMessagePayload) => {
      const { message } = payload;
      if (!message.value) return;
      try {
        const event = JSON.parse(message.value.toString('utf8')) as TransactionEvent;
        buffer.push(event);
      } catch (err) {
        console.error('[kafka] bad message', (err as Error).message);
      }
    },
  });

  console.log(`[kafka] consuming topic "${config.kafkaTopic}" @ ${config.kafkaBrokers.join(',')}`);
  return consumer;
}
