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

Requires Node.js 22.13 or newer (the local database uses Node's built-in SQLite).

## Quick start

Start the stack (`node scripts/setup.mjs && docker compose up -d`, see the root README), then:

```bash
tokenistt login            # prompts for the gateway URL and a credential
tokenistt doctor           # checks the install, credentials and gateway; tells you how to fix anything red
tokenistt connect          # discovers your organization, workspaces and projects
tokenistt connection status
```

## Codebase graph

`tokenistt map` turns the repository into nodes (files, functions, classes, tables, env vars, packages, services, tests, docs) and relationships (`IMPORTS`, `CALLS`, `EXTENDS`, `TESTS`, `READS_FROM`, ...). Re-running only re-parses files whose content changed.

**What it reads:** files from `git ls-files`, so `.gitignore` is respected. Secrets (`.env*`, keys, credential files), dependencies, build output, binaries and files over 1 MB are never read, even when committed. Add your own patterns under `index.exclude` in `.tokenistt/config.json`.

**What it stores:** structure only, never source text. Environment variables are recorded by name, never by value.

**How far to trust edges:** nothing here uses a type checker. Every edge has a `resolution` and `confidence`: an `IMPORTS` edge to a resolved path is exact, while a `CALLS` edge is matched by name. Calls that can't be resolved are counted in `--stats` and left out, never guessed. Dynamic dispatch and calls on instances held in variables are the usual reasons.

| Language | Parser | Extracted | Status |
|---|---|---|---|
| TypeScript, TSX, JavaScript | tree-sitter | symbols, imports, re-exports, calls, heritage, env vars | tested |
| Python | tree-sitter | symbols, imports, calls, heritage, env vars | tested |
| Java | tree-sitter | symbols, imports, same-package names, calls, heritage, env vars | tested on fixtures |
| Go | tree-sitter | symbols, module imports, same-package names, receiver methods, calls, env vars | tested on fixtures |
| Rust | tree-sitter | symbols, `use` and `mod`, impl methods, traits, calls, env vars | tested on fixtures |
| PHP | tree-sitter | symbols, namespaces (PSR-4 by path), `require`, calls, heritage, env vars | tested on fixtures |
| C# | tree-sitter | symbols, namespaces, calls, heritage, env vars | tested on fixtures |
| C, C++ | tree-sitter | symbols, `#include`, calls, heritage, env vars. Macros are not expanded | tested on fixtures |
| SQL (PostgreSQL DDL) | tokenizer, not a full parser | tables, views, columns, foreign keys, `ALTER TABLE` | tested |
| YAML | `yaml` library | docker-compose services, dependencies, env var names | tested |
| JSON | `JSON.parse` | `package.json` and `composer.json` dependencies, `tsconfig` path aliases | tested |
| Manifests | line scan | `go.mod`, `Cargo.toml`, `pom.xml`, `pyproject.toml`, `.csproj` dependencies | tested on fixtures |
| Markdown | link scan | relative links to files | tested |

Framework analyzers, each tested on fixtures, add API endpoints, components and table access on top:

| Framework | What it finds |
|---|---|
| Express and similar routers | routes on variables named `app`, `server` or `*router`, `app.use` mount prefixes, handlers and the calls inside inline handlers |
| Next.js | App Router `route` and `page` files, `pages/api` |
| React | components (capitalised functions in `.tsx`/`.jsx` that render JSX) and which components use which |
| NestJS | `@Controller`, `@Get` and friends, constructor injection |
| FastAPI, Flask | route decorators, `APIRouter` prefixes, `include_router` |
| Django | `urls.py` paths without `include` prefixes, models, `Model.objects` access |
| Spring Boot | `@RestController`, `@GetMapping` and friends, `@Autowired`, `@Entity` |
| PostgreSQL | tables read or written by SQL strings in `query`-style calls, only if the repository defines the table |
| Drizzle, Prisma, Supabase | table definitions and access through the client |

These read syntax, so a route built from a variable, or a client under an unusual name, is missed rather than guessed. A mount prefix held in a variable, like FastAPI's `prefix=settings.API_V1_STR`, leaves the route without that prefix. Node.js entry points come from `package.json`.

C# base classes and interfaces share one syntax, so the `I` prefix convention decides between `EXTENDS` and `IMPLEMENTS`. Files in other languages still appear as file nodes.

Macros are not expanded, so macro-heavy C and C++ report syntax errors and yield partial symbols: 245 of nlohmann/json's 619 C++ files did when we tried it. Those files are counted in `--stats`.

### Exploring it

`tokenistt graph --open` runs a viewer that starts from your top-level folders. Double-click an area to open it; connections roll up to whatever is on screen, so a large repository stays readable and only what you open is drawn. Click anything for its details, and use **Show what depends on this** to see the impact of changing it. Dashed lines are inferred from names; solid lines are stated in the code.

The viewer needs no network. It listens only on `127.0.0.1`, requires the random token in the URL it prints, and can't change anything.

## Coding agents

`tokenistt agents connect <agent>` adds hooks to the agent's own settings file, so sessions are recorded as they happen. It works with `claude-code`, `codex` and `antigravity`, and each can report different things: see [what each agent exposes](../docs/cli/AGENTS.md). Claude Code has been run live; Codex and Antigravity are written from their documentation and are not yet checked against the real agents. Project scope is the default, and `--user` uses your user-level settings instead. It shows the change and asks first, keeps everything else in the file, saves a backup, and refuses to touch a file it can't parse. `agents disconnect` removes only Tokenistt's entries.

**What's recorded:** session start and end, which files were read or changed, tool names, whether things failed, and the program of each command, plus the subcommand for well-known tools (`npm test`, `git push`, but never arguments).

**What isn't:** prompts, file contents, tool output and error text. Set `privacy.commands` to `none` or `redacted` to change what's kept of commands. `privacy.capturePrompts` opts in to storing prompts. Events stay in `.tokenistt/sessions`, which is ignored by git.

**Tokens and cost:** tokens come from Claude Code's transcript, which has an undocumented format, so they may become unknown after an agent update. Codex and Antigravity don't report tokens, so theirs show as unknown. A cost appears only if the catalog has a price for every token type used, and it's an estimate, tokens times catalog prices. It isn't your bill, and on a subscription it isn't spend at all. There are no built-in prices. A session with no price shows as unknown, never $0.

Hooks never block the agent: they do one small file append, and always exit successfully even if something goes wrong.

## Project memory

`tokenistt memory update` builds memory from things it can point at, so you can always see where an entry came from:

| Source | Becomes |
|---|---|
| Finished agent sessions | session summaries, implementation progress, debugging history (tests failed, then passed), known issues (tests still failing at the end) |
| Decision records (`docs/adr/*.md`, `decisions/*.md`) and `Decision:` commit trailers | architectural decisions |
| Commits | recent changes |
| The graph | architecture, module context, important dependencies |
| README, manifests, `CONTRIBUTING` and agent instruction files | project overview, tech stack, a pointer to your conventions |
| You, with `tokenistt memory add` | whatever you tell it, such as open tasks or failed approaches |

There's no model in the loop, so **it won't infer a decision from your code**: decisions are only recorded where someone wrote one down. Routine commands never become memories.

Nothing is overwritten. An updated fact supersedes the old version, which stays in the history (`memory show --id`). A memory goes stale when its subject has left the graph, when its review date passes, or when something contradicts it: a failing-tests issue goes stale once tests pass in a later session on that branch. Stale entries are still shown, labelled as stale.

Memory stays in `.tokenistt/`, and anything credential-shaped is scrubbed before it's stored.

## Context for agents

`tokenistt context --task "Add rate limiting"` picks what matters for a task: files you're changing, code the task mentions, decisions, known issues, conventions, and what depends on the code. It fits an approximate token budget (`--max-tokens`, about four characters per token), says what it left out, and marks where each line came from.

`tokenistt context inject` makes that available to connected agents:

| Agent | How it arrives | What it writes |
|---|---|---|
| Claude Code, Codex | handed over by the hook when a session starts | `.tokenistt/context/<agent>.md` only |
| Antigravity | a rule file | `.agents/rules/tokenistt.md`, its own file |
| Any, with `--merge` | a marked block in `CLAUDE.md` or `AGENTS.md` | after a preview and your yes |

**It never overwrites a file you wrote.** `--merge` only touches the block between its markers, and `--remove` takes it out again. `context preview` shows what an agent would receive, and `--dry-run` shows the change.

The context is a snapshot, so run `inject` again to refresh it. It includes text from your repository, such as your README, and is labelled for the agent as data rather than instructions. That labelling reduces the risk from a repository you don't trust; it doesn't remove it.

### MCP

`tokenistt mcp` gives any MCP-capable agent `project_context`, `graph_search`, `graph_node`, `impact`, `memory_search`, `memory_add` and `sessions_recent`, with no network. For Claude Code: `claude mcp add tokenistt -- node /path/to/cli/bin/tokenistt.js mcp`. `memory_add` is how an agent can record a decision, and entries it adds are labelled as coming from an agent. This is separate from `apps/mcp-server`, which reads spend and budgets from a running stack.

## Change impact

`tokenistt impact src/auth/session.ts` follows the graph backwards from a file or symbol to list what depends on it, which API routes reach it, the tables involved, the tests to run, the modules affected and any related decisions. `--staged` does the same for what you're about to commit.

`tokenistt changes` lists what changed, with dependents, tests and how often each file has changed lately, and flags what may deserve a closer look. Use `--since HEAD~5` or `--compare main` for other ranges.

**This shows connections, not outcomes.** It lists what's linked to a change, not what will break, and inferred links are marked. Dynamic dispatch and anything the graph can't see won't appear, so a short list isn't proof that a change is safe. An agent session appears next to a file if it edited that path, which doesn't mean it made this exact change.

## Search

`tokenistt search` combines names in the graph, connected code, memory and session history, and shows which signals found each result. It needs no network.

Semantic search is optional and off by default. To turn it on, create `intelligence.json` in your Tokenistt config folder, then run `tokenistt embeddings`:

```json
{ "embeddings": { "baseUrl": "http://localhost:11434/v1", "model": "nomic-embed-text" } }
```

Any OpenAI-compatible endpoint works, including a local Ollama. Only symbol names and file paths are sent, never source code. Those can still be sensitive, so check before using a remote endpoint. This setting is only read from your own config folder, so a cloned repository can't redirect it.

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
| `tokenistt init` | Set up this repository: `.tokenistt/` and the local database. Safe to re-run; needs no network |
| `tokenistt map` | Build the codebase knowledge graph in `.tokenistt/graph`. `--full`, `--incremental`, `--watch`, `--stats`, `--export json [--out dir]`, `--import file`. Needs no network |
| `tokenistt graph` | Summary of the graph. `--open` starts the interactive viewer in your browser (`--no-browser`, `--port`) |
| `tokenistt agents` | Which coding agents are installed and connected. `connect <agent>`, `disconnect <agent>`, `capabilities` |
| `tokenistt sessions` | Recent agent sessions. `history`, `inspect <id>`, `compare <id1> <id2>`, `--agent` |
| `tokenistt watch` | Live view of agent sessions. `--agent`, `--project <path>`. Prints events as text or NDJSON when piped |
| `tokenistt memory` | What Tokenistt remembers about this project. `update`, `show`, `search`, `add`, `edit`, `forget`, `export`, `stats` |
| `tokenistt context` | What an agent should know for a task. `--task`, `--max-tokens`, `--format`, `preview`, `inject` |
| `tokenistt mcp` | Serve the graph, memory and sessions as local MCP tools over stdio |
| `tokenistt impact <file or symbol>` | What a change could affect: dependents, API routes, tables, tests, modules, decisions. `--staged`, `--depth` |
| `tokenistt changes` | What changed, and what deserves a closer look. `--since <rev>`, `--compare <ref>` |
| `tokenistt search <query>` | Find related code, memories and sessions |
| `tokenistt analyze` | Circular imports, coupling, boundaries, entry points, isolated files, possible duplicates. `--trace "GET /users"` follows a route to its tables |
| `tokenistt embeddings` | Optional: build vectors for semantic search |
| `tokenistt login` | Authenticate and store credentials (see above) |
| `tokenistt logout` | Remove stored credentials (environment variables are untouched and reported) |
| `tokenistt auth status` | Which credentials are in effect, masked, with source and expiry. Local, no network |
| `tokenistt auth whoami` | Ask the gateway who you are: actor, role, organization |
| `tokenistt auth configure --api-url <url> --org-id <id>` | Change non-secret settings |
| `tokenistt connect` | Verify the link; list your organization, workspaces and projects; remember the connection |
| `tokenistt disconnect` | Forget the saved connection (keeps credentials) |
| `tokenistt connection status` | Probe the gateway now: `connected`, `offline` or `unauthorized` |
| `tokenistt doctor` | Check Node version, project setup, local database, config file permissions, credentials, gateway health, management access and API key |

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
2. Local SQLite queue and `sync` — records usage events locally and sends them to `/v1/ingest/events` (already shipped).
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
`src/config` (credential store); `src/project` reads git and manifests; `src/store` owns `.tokenistt/` and SQLite; `src/core` holds output, errors, redaction and prompts.
