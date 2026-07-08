import { worker } from "./worker";
import { scheduleDaily } from "./queue";

// Production entry: start the BullMQ worker + schedule the daily scan job.
async function main() {
  console.log("Shadow AI scanner worker starting…");
  await scheduleDaily();
  console.log("Worker is listening for 'shadow-ai-scan' jobs.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
