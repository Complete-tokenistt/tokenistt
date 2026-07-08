import { config } from './config.js';
import { IngestBuffer } from './ingest.js';
import { AnomalyScheduler } from './anomalies.js';
import { startConsumer } from './kafka.js';

async function main(): Promise<void> {
  const buffer = new IngestBuffer(config.batchSize, config.flushMs);
  buffer.start();

  const anomalies = new AnomalyScheduler();
  anomalies.start();

  const consumer = await startConsumer(buffer);

  const shutdown = async (signal: string) => {
    console.log(`[main] ${signal} received, draining...`);
    anomalies.stop();
    try {
      await consumer.disconnect();
    } catch {
      /* ignore */
    }
    await buffer.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[main] fatal', err);
  process.exit(1);
});
