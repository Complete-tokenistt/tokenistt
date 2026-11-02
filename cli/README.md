# tokenistt CLI

Command-line client for a self-hosted [Tokenistt](../README.md) gateway. It talks to the same gateway and
database the dashboard uses, so numbers you see in the terminal are the numbers on the dashboard.

> **Status: early.** This release covers authentication, connection management and diagnostics.
> Usage/cost reports, attribution, providers, policies, `init` and offline sync are planned and listed under
> [Roadmap](#roadmap). Nothing below documents a command that does not exist yet.

## Install

From a clone of this repository (the package is not published to npm yet):

```bash
npm install
npm run build -w cli
node cli/bin/tokenistt.js --help          # or: npm link -w cli   →  tokenistt --help
```

Requires Node.js 20 or newer.

## Quick start

Start the stack (`node scripts/setup.mjs && docker compose up -d`, see the root README), then:

```bash
tokenistt login            # prompts for the gateway URL and a credential
tokenistt doctor           # checks the install, credentials and gateway; tells you how to fix anything red
tokenistt connect          # discovers your organization, workspaces and projects
tokenistt connection status
```

## Credentials

The gateway has three kinds of credential. Use whichever matches what you need to do:

| Credential | Used for | Where to get it |
|---|---|---|
| **Dashboard token** (JWT) | management commands: whoami, discovery, (later) usage, cost, policies | sign in to the dashboard (`AUTH_MODE=jwt`) and copy your session token |
| **Operator admin secret** + organization id | the same, without a dashboard user (self-hosted operators) | `ADMIN_SECRET` in the gateway's `.env`; the numeric organization id |
| **Virtual API key** (`tktt_live_…`) | sending usage events, `usage/me` | dashboard → API keys |

**Secrets are never accepted as command-line arguments** (they would land in shell history and `ps`). Provide them by:

```bash
# hidden prompt (interactive)
tokenistt login

# stdin (scripts)
printf %s "$DASHBOARD_TOKEN" | tokenistt login --token-stdin --api-url https://tokenistt.example.com
printf %s "$ADMIN_SECRET"    | tokenistt login --admin-secret-stdin --org-id 1
printf %s "$TOKENISTT_KEY"   | tokenistt login --api-key-stdin

# environment (CI: no login step needed)
export TOKENISTT_API_URL=https://tokenistt.example.com
export TOKENISTT_TOKEN=...            # dashboard token
export TOKENISTT_ADMIN_SECRET=... TOKENISTT_ORG_ID=1
export TOKENISTT_API_KEY=tktt_live_...
```

`login` checks every credential against the gateway first and stores nothing if one is rejected, so a typo never
overwrites a working login. Environment variables always take precedence over the stored file.

**Where it is stored:** `~/.config/tokenistt/config.json` (`%APPDATA%\tokenistt\config.json` on Windows, or
`$TOKENISTT_CONFIG_DIR`), mode `0600`. There is no OS-keychain integration yet. On Windows the file relies on the
user-profile ACLs.

**Limits you should know about:** there is no browser/device login and no token refresh yet (the gateway has no such
endpoint). Dashboard tokens expire; `tokenistt auth status` shows when, and `doctor` flags an expired one.

## Commands

| Command | What it does |
|---|---|
| `tokenistt login` | Authenticate and store credentials (see above) |
| `tokenistt logout` | Remove stored credentials (environment variables are untouched and reported) |
| `tokenistt auth status` | Which credentials are in effect, masked, with source and expiry. Local, no network |
| `tokenistt auth whoami` | Ask the gateway who you are: actor, role, organization |
| `tokenistt auth configure --api-url <url> --org-id <id>` | Change non-secret settings |
| `tokenistt connect` | Verify the link; list your organization, workspaces and projects; remember the connection |
| `tokenistt disconnect` | Forget the saved connection (keeps credentials) |
| `tokenistt connection status` | Probe the gateway now: `connected`, `offline` or `unauthorized` |
| `tokenistt doctor` | Check Node version, config file permissions, credentials, gateway health, management access and API key |

### Global options

| Option | Effect |
|---|---|
| `--json` | Machine-readable result on stdout; errors as JSON on stderr |
| `--quiet` | Suppress informational lines (results and errors still print) |
| `--verbose` | Debug log on stderr: each request and retry, credentials redacted |
| `--no-color` | Plain output (also honoured: `NO_COLOR`, non-TTY stdout) |
| `--api-url <url>` | Gateway URL for this invocation |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | other failure (including failed `doctor` checks) |
| `2` | usage error (bad flags, missing input in a non-interactive session) |
| `3` | authentication failed, expired, or no credentials |
| `4` | gateway unreachable (offline); safe to retry later |
| `5` | blocked by a policy (reserved for upcoming commands) |

Network calls are retried with exponential backoff and jitter on connection failures and `429/502/503/504`
(honouring `Retry-After`); only requests that are safe to repeat are retried.

## Use in CI

```yaml
- run: npm install -g tokenistt          # once published; until then build from the repo
- run: tokenistt doctor --json
  env:
    TOKENISTT_API_URL: ${{ vars.TOKENISTT_API_URL }}
    TOKENISTT_API_KEY: ${{ secrets.TOKENISTT_API_KEY }}
```

`doctor` exits non-zero when a check fails; `connection status` exits `4` when the gateway is down, so a pipeline can
tell "retry later" from "fix the credentials" (`3`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not reach the Tokenistt gateway` (exit 4) | Is the stack running (`docker compose ps`)? Is `TOKENISTT_API_URL` the **gateway** (default port 3000), not the dashboard? |
| `answered, but it has no /health endpoint` | Something else is listening on that URL. Point the CLI at the gateway |
| `The gateway rejected the credentials` (exit 3) | Token expired or key revoked: `tokenistt login` again |
| `Not allowed: Role 'viewer' lacks permission …` | Your role cannot do this. `tokenistt auth whoami` shows your role |
| `Cannot prompt … in a non-interactive session` | Use `--…-stdin` flags or the environment variables |

## Roadmap

Planned in this order (see [`docs/cli/PLAN.md`](../docs/cli/PLAN.md)); none of these exist yet:

1. `usage`, `cost`, `attribution`, `models`, `providers` — reads from the gateway's `/v1/admin/usage/summary` (already shipped in the gateway).
2. `init`, local SQLite queue and `sync` — records usage events locally and sends them to `/v1/ingest/events` (already shipped); needs Node 22.13+ for the local store.
3. `policy` (YAML apply/test, using the gateway's dry-run endpoint) and `optimize` (rule-based findings with evidence).
4. npm publishing workflow.

Not planned for now: browser/device login and keychain storage (need dashboard + gateway work), a dedicated Mistral
adapter (use the OpenAI-compatible provider), currency conversion (USD only).

## Development

```bash
npm install
npm run build -w cli
npm test -w cli            # unit tests + end-to-end tests that spawn the real CLI against a fake gateway
npm run typecheck -w cli
```

Layout: `src/commands` (thin commander wiring) → `src/services` (logic, no terminal I/O) → `src/api` (gateway client) and
`src/config` (credential store); `src/core` holds output, errors, redaction and prompts.
