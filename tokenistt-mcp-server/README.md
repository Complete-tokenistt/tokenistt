# Tokenistt FinOps MCP Server

The **Tokenistt Model Context Protocol (MCP) Server** connects AI engineering assistants (Claude Desktop, Cursor, Antigravity, etc.) directly to your Tokenistt FinOps intelligence plane.

This enables your AI agents to reason about real-time AI spending, verify budget headroom, analyze cost spikes, benchmark alternative models, and safely route prompts before making expensive API calls.

---

## Capabilities & Tools

| Tool | Description | Parameters |
|---|---|---|
| `get_spend_summary` | Total spend, requests, latency, and per-provider breakdown | `period`: `"today"` \| `"week"` \| `"month"` (default: `"month"`), `org_id?` |
| `check_budget_status` | Active budget caps, spent vs allocated, % utilized, and health indicators (`HEALTHY`, `WARNING`, `EXCEEDED`) | `workspace_id?` |
| `estimate_prompt_cost` | Calculate exact projected USD cost for a model given token counts | `model`, `input_tokens`, `output_tokens` |
| `detect_anomalies` | Identify cost spikes and abnormal usage surges exceeding baseline | `period`: `"24h"` \| `"7d"`, `min_ratio?` |
| `list_cost_centers` | List all cost centers, business owners, spend MTD, and MoM trends | _(none)_ |
| `get_team_spend` | Breakdown of AI spend per developer / team member, primary models used, and volume | `team_id?` |
| `compare_models` | Side-by-side cost & token pricing comparison across multiple models on a sample prompt | `models: string[]`, `sample_prompt: string` |
| `route_prompt` | Smart routing engine: selects the optimal cost/quality model and returns the completion | `prompt`, `user?`, `maxCostUsd?`, `preferQuality?` |

### Resources
- `spend_report://{user}/daily`: Real-time daily spend ledger for a specific developer or service actor.

### Prompts
- `optimize_cost`: Context prompt that analyzes a recent conversation or prompt template and recommends cheaper model alternatives.

---

## Configuration & Setup

### 1. Claude Desktop Setup

Open your Claude Desktop configuration file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add the `tokenistt` server:

```json
{
  "mcpServers": {
    "tokenistt": {
      "command": "node",
      "args": [
        "A:/tokenist/tokenist-main/tokenistt-mcp-server/index.js"
      ],
      "env": {
        "TOKENISTT_DASHBOARD_URL": "http://localhost:3001",
        "TOKENISTT_GATEWAY_URL": "http://localhost:4000",
        "TOKENISTT_API_KEY": "tktt_live_acme_jane_abc123def456"
      }
    }
  }
}
```

### 2. Cursor Setup

Add to `.cursor/mcp.json` in your project root or in **Cursor Settings → MCP Servers**:

```json
{
  "mcpServers": {
    "tokenistt": {
      "command": "node",
      "args": [
        "A:/tokenist/tokenist-main/tokenistt-mcp-server/index.js"
      ],
      "env": {
        "TOKENISTT_DASHBOARD_URL": "http://localhost:3001"
      }
    }
  }
}
```

### 3. Remote / HTTP SSE Transport (Optional)

If running as a shared remote service for team members:

```bash
MCP_TRANSPORT=sse PORT=3002 node tokenistt-mcp-server/index.js
```
Clients connect to `http://<host>:3002/sse` and post to `http://<host>:3002/messages`.

---

## Example Natural Language Prompts

Once configured, you can query your FinOps assistant naturally:

- **Spend Inquiries**:
  > *"How much have we spent on AI this month, and which provider is costing us the most?"*  
  *(Invokes `get_spend_summary(period="month")`)*

- **Budget Verification**:
  > *"Are any teams close to exceeding their AI budget caps?"*  
  *(Invokes `check_budget_status()`)*

- **Cost Estimation**:
  > *"If I run 50,000 input tokens and 10,000 output tokens on GPT-4o vs Claude 3.5 Sonnet, what's the cost difference?"*  
  *(Invokes `compare_models(models=["gpt-4o", "claude-3-5-sonnet"], ...)`)*

- **Spike Investigation**:
  > *"Did we have any abnormal spending spikes in the last 24 hours?"*  
  *(Invokes `detect_anomalies(period="24h")`)*

- **Team Usage**:
  > *"Who are the top 3 spenders on the engineering team this month?"*  
  *(Invokes `get_team_spend()`)*

