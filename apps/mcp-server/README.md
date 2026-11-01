# Tokenistt MCP server

Lets MCP clients (Claude Desktop, Cursor, Cline, …) ask your **running Tokenistt stack** about spend, budgets,
anomalies and model prices. Every tool reads live data; if the stack is unreachable the tool returns an error that says
so — it never substitutes made-up numbers.

## Tools

| Tool | What it does |
|---|---|
| `get_spend_summary` | This month's spend, request count, latency and per-provider breakdown |
| `check_budget_status` | Budgets with spend, percent used and status (`name_contains?`) |
| `estimate_prompt_cost` | Cost of `model` × `input_tokens`/`output_tokens` from the live price catalog; errors if the model has no price |
| `detect_anomalies` | Spikes versus each actor's baseline (`period`: `24h`/`7d`, `min_ratio?`) |
| `list_cost_centers` | Cost centers with spend this month |
| `get_team_spend` | Spend per team member this month |
| `compare_models` | Catalog price plus your observed latency/cost/error rate (last 30 days) for several models |
| `route_prompt` | Sends a prompt through the gateway using the cheapest priced model that fits `max_cost_usd`. Needs `TOKENISTT_API_KEY` |

Resource `spend_report://{user}/daily` — today's spend and request count for one actor.
Prompt `optimize_cost` — reviews a conversation against your live price list.

## Set up

```bash
npm install
npm run build --workspace=apps/mcp-server
```

Add to your client's MCP config (use the absolute path to this checkout):

```json
{
  "mcpServers": {
    "tokenistt": {
      "command": "node",
      "args": ["/absolute/path/to/tokenistt/apps/mcp-server/dist/index.js"],
      "env": {
        "TOKENISTT_DASHBOARD_URL": "http://localhost:3001",
        "TOKENISTT_GATEWAY_URL": "http://localhost:3000",
        "TOKENISTT_API_KEY": "tktt_live_..."
      }
    }
  }
}
```

| Variable | Default | Needed for |
|---|---|---|
| `TOKENISTT_DASHBOARD_URL` | `http://localhost:3001` | every tool except `route_prompt` |
| `TOKENISTT_GATEWAY_URL` | `http://localhost:3000` | `route_prompt` |
| `TOKENISTT_API_KEY` | – | `route_prompt` (a virtual key from **API keys** in the dashboard) |
| `TOKENISTT_DASHBOARD_TOKEN` | – | only when the dashboard runs with `AUTH_MODE=jwt` |

Verify it against your stack: `npm run smoke --workspace=apps/mcp-server`.

## Remote (SSE) transport

```bash
MCP_TRANSPORT=sse PORT=3002 node dist/index.js
```

Clients connect to `http://<host>:3002/sse`. There is no authentication on this endpoint — keep it on a private network.
