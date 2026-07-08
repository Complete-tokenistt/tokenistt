import { persistAnomalies } from './clickhouse.js';
import { config } from './config.js';

/**
 * Periodically materialize anomaly flags into `spend_anomalies`.
 * Runs every `ANOMALY_INTERVAL_MS` (default 5 min).
 */
export class AnomalyScheduler {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    // Run once shortly after startup, then on the interval.
    this.timer = setInterval(() => void this.run(), config.anomalyIntervalMs);
    this.timer.unref?.();
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      await persistAnomalies();
      console.log('[anomaly] persisted flags');
    } catch (err) {
      console.error('[anomaly] failed', (err as Error).message);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
