import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { REDIS_URL } from "./config";
import { runScan } from "./run";

const connection = { url: REDIS_URL } as ConnectionOptions;

// BullMQ worker that processes "shadow-ai-scan" jobs (enqueued daily by queue.ts).
export const worker = new Worker(
  "shadow-ai-scan",
  async (_job: Job) => {
    await runScan();
  },
  { connection, concurrency: 1 },
);

worker.on("completed", () => console.log("[worker] scan job completed"));
worker.on("failed", (job, err) => console.error("[worker] scan job failed", job?.id, err));
