/**
 * Synthetic load generator for local testing. Generates transaction events and
 * publishes them to the `transactions` Kafka topic, including a "spike" user
 * whose last-hour spend exceeds 3x their 30-day average (to exercise anomaly
 * detection). Run with:  docker compose exec consumer npm run producer
 */
import { Kafka, logLevel } from 'kafkajs';
import { config } from '../src/config.js';

const PROVIDERS = ['openai', 'anthropic', 'tokenistt-gateway'];
const COST_CENTERS = ['CC-4401-Support', 'CC-4402-Eng', 'CC-8800-Research'];
const MODELS = ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'o3-mini'];
const USERS = Array.from({ length: 40 }, (_, i) => `user-${i}@example.com`);
const SPIKE_USER = 'spike@example.com';

function rnd<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  const model = rnd(MODELS);
  const prompt = Math.floor(Math.random() * 4000) + 100;
  const completion = Math.floor(Math.random() * 2000) + 50;
  const inCost = round2((prompt / 1_000_000) * 2.5);
  const outCost = round2((completion / 1_000_000) * 10);
  return {
    organization_id: 1,
    workspace_id: 10,
    virtual_key_id: 100,
    actor: rnd(USERS),
    provider: rnd(PROVIDERS),
    model,
    endpoint: '/chat/completions',
    request_id: 'req_' + Math.random().toString(36).slice(2),
    cost_center: rnd(COST_CENTERS),
    currency: 'USD',
    cost_usd: round2(inCost + outCost),
    amortized_cost_usd: round2(inCost + outCost),
    input_cost_usd: inCost,
    output_cost_usd: outCost,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    status: 'success',
    shadow_ai_flag: Math.random() < 0.02,
    duration_ms: Math.floor(Math.random() * 2000) + 50,
    created_at: new Date().toISOString(),
    ...over,
  };
}

async function main(): Promise<void> {
  const kafka = new Kafka({ brokers: config.kafkaBrokers, logLevel: logLevel.WARN });
  const producer = kafka.producer();
  await producer.connect();
  console.log(`[producer] -> topic "${config.kafkaTopic}" @ ${config.kafkaBrokers.join(',')}`);

  const send = async (msgs: Record<string, unknown>[]) => {
    await producer.send({
      topic: config.kafkaTopic,
      messages: msgs.map((value) => ({ value: JSON.stringify(value) })),
    });
  };

  // 1) 30 days of baseline history for normal users (a few events/day).
  let sent = 0;
  for (let d = 30; d >= 1; d--) {
    const dayMsgs: Record<string, unknown>[] = [];
    for (const u of USERS) {
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const ts = Date.now() - d * 86_400_000 - Math.floor(Math.random() * 86_400_000);
        dayMsgs.push(event({ actor: u, created_at: new Date(ts).toISOString() }));
      }
    }
    await send(dayMsgs);
    sent += dayMsgs.length;
  }
  console.log(`[producer] baseline history: ${sent} events`);

  // 2) Spike user: low baseline (~$1/day) + a big last-hour burst (~$60).
  const spikeBaseline: Record<string, unknown>[] = [];
  for (let d = 30; d >= 1; d--) {
    const ts = Date.now() - d * 86_400_000;
    spikeBaseline.push(
      event({ actor: SPIKE_USER, cost_usd: 1, amortized_cost_usd: 1, input_cost_usd: 0.5, output_cost_usd: 0.5, created_at: new Date(ts).toISOString() }),
    );
  }
  await send(spikeBaseline);

  const burst: Record<string, unknown>[] = [];
  for (let i = 0; i < 200; i++) {
    const ts = Date.now() - Math.floor(Math.random() * 3_600_000); // within last hour
    burst.push(event({ actor: SPIKE_USER, cost_usd: 0.3, amortized_cost_usd: 0.3, created_at: new Date(ts).toISOString() }));
  }
  await send(burst);
  console.log(`[producer] spike user baseline ${spikeBaseline.length} + burst ${burst.length}`);

  // 3) Keep streaming live traffic until Ctrl-C.
  console.log('[producer] streaming live traffic (Ctrl-C to stop)...');
  const timer = setInterval(async () => {
    await send([event()]);
  }, 50);
  timer.unref?.();

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      clearInterval(timer);
      resolve();
    });
  });

  await producer.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('[producer] fatal', err);
  process.exit(1);
});
