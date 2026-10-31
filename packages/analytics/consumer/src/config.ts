import 'dotenv/config';

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((s) => s.trim()),
  kafkaTopic: process.env.KAFKA_TOPIC ?? 'transactions',
  kafkaGroup: process.env.KAFKA_GROUP ?? 'tokenistt-analytics',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    user: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DATABASE ?? 'default',
  },
  batchSize: intEnv('BATCH_SIZE', 5000),
  flushMs: intEnv('FLUSH_MS', 2000),
  anomalyIntervalMs: intEnv('ANOMALY_INTERVAL_MS', 300000),
};
