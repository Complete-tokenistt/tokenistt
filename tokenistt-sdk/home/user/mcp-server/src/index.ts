import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { startSse } from "./transports/sse.js";
import { TRANSPORT, PORT } from "./config.js";

async function main() {
  if (TRANSPORT === "sse") {
    startSse(PORT);
  } else {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    // MCP reserves stdout for the protocol; log to stderr.
    console.error("Tokenistt MCP server running on stdio");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
