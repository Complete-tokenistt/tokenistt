import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { buildServer } from "../server";

// MCP SSE transport (spec 2024-11-05): client opens GET /sse (stream + gets a
// sessionId), then POSTs messages to /messages?sessionId=...
export function startSse(port: number): void {
  const app = express();
  const transports = new Map<string, SSEServerTransport>();

  app.get("/sse", async (_req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => transports.delete(transport.sessionId));
    const server = buildServer();
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "unknown sessionId" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  app.listen(port, () =>
    console.error(`Tokenistt MCP server (SSE) listening on http://localhost:${port}/sse`),
  );
}
