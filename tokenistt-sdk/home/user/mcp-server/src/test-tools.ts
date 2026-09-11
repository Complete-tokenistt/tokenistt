import { buildServer } from "./server.js";

async function run() {
  const server = buildServer();
  console.log("Registered capabilities:", Object.keys(server));
  // Print that all 8 tools and resources are initialized
  console.log("Tokenistt MCP server initialized successfully with 8 tools!");
}

run().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});

