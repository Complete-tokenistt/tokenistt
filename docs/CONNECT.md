# Connecting your tools to Tokenistt

Tokenistt exposes an **OpenAI-compatible API**, so anything that lets you set a base URL and API key can send traffic
through it. Every request then shows up in the dashboard (**Request history**, **Usage**, **Budgets**) with its cost.

You need two things:

| | Value (default local stack) |
|---|---|
| Base URL | `http://localhost:3000/v1` |
| API key | a Tokenistt virtual key (`tktt_live_…`) |

## 1. Get a key

Dashboard → **Settings → API keys** → create one. The token is shown once. Or from the command line:

```bash
curl -s -X POST http://localhost:3001/api/gateway/keys \
  -H 'content-type: application/json' -d '{"name":"my-laptop"}'
# → { ..., "token": "tktt_live_org1_my-laptop_…" }
```

(That call works without credentials only in the default no-login mode, `AUTH_MODE=open`.)

## 2. Try it

```bash
export TOKENISTT_KEY=tktt_live_...

curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $TOKENISTT_KEY" -H 'content-type: application/json' \
  -d '{"model":"mock:echo","messages":[{"role":"user","content":"hello"}]}'
```

`mock:echo` is an offline provider (on by default, `MOCK_PROVIDER=1`), so you can verify the wiring without any
provider keys. For real models, add a key to `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`,
`GEMINI_API_KEY`, `TOGETHER_API_KEY`) or store per-org keys in the dashboard under **Providers & Keys**, then use
`gpt-4o`, `claude-3-5-sonnet`, `groq:llama-3.3-70b-versatile`, … as the model name. `GET /v1/models` lists what is available.

Streaming (`"stream": true`) is supported. Requests that match a routing rule, or go to a provider without native
streaming (mock, Bedrock), are served through the router and replayed as a stream.

## 3. SDKs

Any OpenAI SDK works by changing two settings:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3000/v1", api_key="tktt_live_...")
```

```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: process.env.TOKENISTT_KEY });
```

Tools that read environment variables: `OPENAI_BASE_URL=http://localhost:3000/v1 OPENAI_API_KEY=$TOKENISTT_KEY`.

## 4. Editors

### VS Code — Continue

`~/.continue/config.yaml`:

```yaml
models:
  - name: Tokenistt · gpt-4o
    provider: openai
    model: gpt-4o
    apiBase: http://localhost:3000/v1
    apiKey: tktt_live_...
```

### VS Code — Cline

Settings → **API Provider: OpenAI Compatible** → Base URL `http://localhost:3000/v1`, API Key `tktt_live_…`,
Model ID `gpt-4o` (or any model your gateway can reach).

### Cursor

Settings → Models → override the OpenAI base URL with your Tokenistt URL and paste the key. Cursor sends model
requests from its own servers, so `localhost` is **not reachable** — expose the gateway on an HTTPS URL first
(a tunnel such as `cloudflared`/`ngrok` for trying it out, a real deployment for teams).

### Any other OpenAI-compatible client

Same two settings. If it asks for a provider type, pick "OpenAI" / "OpenAI-compatible".

## 5. Attribute spend to teams, repos and tickets

Add headers to any request and the dashboard breaks spend down by them:

```
x-tokenistt-team: platform        x-tokenistt-project: copilot
x-tokenistt-repo: acme/api        x-tokenistt-ticket: ENG-1234
x-tokenistt-feature: search       x-tokenistt-customer: acme
```

In SDKs use `default_headers` (Python) / `defaultHeaders` (TypeScript).

## 6. Ask questions about spend from your AI assistant (MCP)

`apps/mcp-server` lets Claude Desktop, Cursor, Cline and other MCP clients query live spend, budgets, anomalies and
prices from your running stack. Build it once:

```bash
npm install
npm run build --workspace=apps/mcp-server
```

Then add it to your client's MCP config, using the absolute path to this checkout:

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

`TOKENISTT_API_KEY` is only used by the `route_prompt` tool. With `AUTH_MODE=jwt` also set `TOKENISTT_DASHBOARD_TOKEN`.
Check it works: `npm run smoke --workspace=apps/mcp-server` (needs the stack running).
Tools never fall back to invented numbers — if the stack is unreachable they return an error saying so.

## 7. See your usage inside VS Code

Install the extension from `apps/vscode-extension` (see its README), run **Tokenistt: Set API Key**, and the status bar shows
spend today and budget used, with a sidebar of top models and recent requests. From code, `client.usage()` (TypeScript) /
`client.usage()` (Python) returns the same data from `GET /v1/usage/me`.
