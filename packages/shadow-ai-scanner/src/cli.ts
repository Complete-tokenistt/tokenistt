import { runScan } from "./run";

// One-off run without Redis/BullMQ — handy for local testing / CI.
//   npm run scan
runScan()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
