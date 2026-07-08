# Tokenistt MCP Server (Prompt 12 — Phase 6)

An **MCP server** that exposes the Tokenistt FinOps gateway to Claude Desktop
and Cursor, per the Model Context Protocol spec **2024-11-05**.

## Capabilities

| MCP primitive | Name | What it does |
| --- | --- | --- |
| **Tool** | `route_prompt` | Routes a prompt to the optimal model by cost/quality and returns the completion (live via gateway when configured). |
| **Resource** | `spend_report://{user}/daily` | Current user's daily spend (from the gateway, or deterministic mock). |
| **Prompt** | `optimize_cost` | Returns a prompt that analyzes a conversation and suggests a cheaper model. |

## Transports

- **Stdio** (default, for Claude Desktop / Cursor local config)
- **SSE** (`MCP_TRANSPORT=sse`, for remote/HTTP clients) — `GET /sse` + `POST /messages?sessionId=...`

## Run

```bash
cd mcp-server
npm install
cp .env.example .env        # optional: set GATEWAY_URL + GATEWAY_API_KEY for live calls

# Stdio (default)
npm start

# SSE
MCP_TRANSPORT=sse PORT=3001 npm start
```

The `route_prompt` tool calls the gateway at `${GATEWAY_URL}/v1/chat/completions`
when configured; otherwise it returns the routing decision only. The
`spend_report` resource reads `${GATEWAY_URL}/internal/usage` when configured.

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "tokenistt": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": {
        "GATEWAY_URL": "http://localhost:8000",
        "GATEWAY_API_KEY": "tk_live_..."
      }
    }
  }
}
```

## Cursor

`.cursor/mcp.json` (project) or Cursor settings → MCP:

```json
{
  "mcpServers": {
    "tokenistt": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"]
    }
  }
}
```

## Notes

- Logs go to **stderr** (MCP reserves stdout for the protocol).
- The model catalog in `src/catalog.ts` mirrors the Prompt 9 benchmarking
  profiles; swap it for a live gateway catalog in production.
- SSE creates a fresh `McpServer` per connection (stateful per session), which
  is the expected pattern for the MCP SSE transport.
