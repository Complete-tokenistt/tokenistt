# Tokenistt for VS Code

See what your AI assistants and agents are costing you without leaving the editor.

- **Status bar** — spend today and % of your key's budget; turns yellow/red as you approach the cap.
- **Sidebar** — today, this month, failed requests, budget headroom, top models and your most recent requests.
- **Budget warnings** — a notification when your key crosses the warning threshold (once per period, not on every refresh).
- **Your key stays yours** — stored in VS Code's encrypted secret storage; the extension only calls your own gateway.

It reads `GET /v1/usage/me` and `GET /v1/logs` from your Tokenistt gateway using **your own API key**, so it never needs an admin credential.
Only traffic that goes **through the gateway** is counted — point your tools (Continue, Cline, SDKs …) at it, see [docs/CONNECT.md](../../docs/CONNECT.md).

## Install

Build the `.vsix` from a checkout, then install it:

```bash
npm install
npm run package -w apps/vscode-extension          # → apps/vscode-extension/tokenistt-vscode-0.1.0.vsix
code --install-extension apps/vscode-extension/tokenistt-vscode-0.1.0.vsix
```

## Use

1. Create a key in the dashboard (**API keys**).
2. Run **Tokenistt: Set API Key** from the command palette and paste it.
3. Done — the status bar shows live usage. Click it to refresh.

| Command | |
|---|---|
| Tokenistt: Set API Key / Remove API Key | store or delete the key |
| Tokenistt: Refresh Usage | fetch now |
| Tokenistt: Open Dashboard / Open Request History | jump to the web UI |
| Tokenistt: Copy OpenAI Connection Settings | copies `OPENAI_BASE_URL` / `OPENAI_API_KEY` for other tools |

| Setting | Default | |
|---|---|---|
| `tokenistt.gatewayUrl` | `http://localhost:3000` | your gateway (no `/v1`) |
| `tokenistt.dashboardUrl` | `http://localhost:3001` | |
| `tokenistt.refreshSeconds` | `60` | |
| `tokenistt.budgetWarnPercent` | `80` | |

## Develop

```bash
npm run build -w apps/vscode-extension       # bundle to out/extension.js
npm test -w apps/vscode-extension            # API client (against a real local HTTP server) and formatting
```

Press **F5** in VS Code with this folder open to launch an Extension Development Host.
