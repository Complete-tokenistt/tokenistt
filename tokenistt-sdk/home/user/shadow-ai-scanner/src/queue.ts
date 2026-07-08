import { Queue, type ConnectionOptions } from "bullmq";
import { REDIS_URL, SCAN_CRON } from "./config";

const connection = { url: REDIS_URL } as ConnectionOptions;

export const scanQueue = new Queue("shadow-ai-scan", { connection });

// Schedule a repeatable daily scan via BullMQ's job scheduler.
export async function scheduleDaily(): Promise<void> {
  await scanQueue.upsertJobScheduler(
    "daily-shadow-ai",
    { pattern: SCAN_CRON },
    { name: "shadow-ai-scan", data: {} },
  );
  console.log(`[queue] scheduled daily scan with cron "${SCAN_CRON}"`);
}
