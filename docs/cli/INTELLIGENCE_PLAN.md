# Plan: Tokenistt developer intelligence CLI

Status: in progress. This is the plan of record; the older [PLAN.md](PLAN.md) covers the gateway-client commands, which are PR 18 here.

## Context
`tokenistt` is growing from a thin gateway client into a local-first engine. It will build a codebase graph, observe coding-agent sessions, keep project memory, generate and inject context, analyse change impact and report cost. Local features must work with no network. The gateway and dashboard stay the shared source of truth when connected.

Starting point: `cli/` has auth, connect and doctor, all uncommitted on `feat/cli-foundation`. The gateway already has `/v1/ingest/events`, `/v1/admin/usage/summary`, `/whoami` and `/policies/test`.

## Decisions
**Product decisions**
- **Positioning:** build everything, but copy says "open-source AI cost visibility and governance" plus "developer intelligence". No "AI FinOps" or "cloud" in UI or docs; the startup check reads "Checking gateway". Update `CLAUDE.md` §2 to record the new stage.
- **Delivery:** stacked PRs, one per change. Merged by a maintainer in order. Each PR is CI-green before the next one starts.
- **Agent cost:** stored in new `agent_sessions` tables, not `transactions`. Opt in per repo to ledger ingest for API-billed usage. Budgets stay real spend.
- **Embeddings:** optional, off by default, stored in local SQLite. No Qdrant and no new service. Add a `CLAUDE.md` note that this differs from the excluded prompt clustering.

**Engineering decisions**
- **Runtime: Node >=22.13**, for `node:sqlite` (FTS5 checked on local Node 24; re-check on 22). Node 20 is past end of life. This changes the CLI's current `engines >=20`. Gateway stays on Node 20. Add a CI job for `cli` on Node 22; the existing Node 20 job skips CLI tests with a visible message.
- **Everything lives in `cli/src`.** No new packages until a second consumer exists.
- **Dependencies added:** `ink`@6, `react`@19, `web-tree-sitter`, `tree-sitter-wasms`, `@modelcontextprotocol/sdk` (already used by `apps/mcp-server`), `picomatch`, `cytoscape`, and `esbuild` (dev, bundles the viewer so it works offline).
- **Dependencies deliberately skipped:** ora, picocolors, cli-table3, @clack. `core/output.ts` and `core/prompt.ts` already cover them, and each one is extra startup cost on hook paths.
- **No `nodes.json`/`edges.json` on disk.** SQLite holds the graph, `graph.json` and `metadata.json` are written, and `--export` produces split files.
- **SQL parsing:** the wasm package has no SQL grammar, so the indexer uses a small tokenizer-based DDL scanner. It is documented as a scanner, not an AST parser.
- **`CALLS` edges are name-resolved, not type-checked.** Each carries `confidence` and `resolution`; the UI shows them as inferred.
- **Memory extraction is deterministic, with no LLM.** Sources: session events, commits, ADR files, and agents calling the MCP `memory_add` tool. Architectural decisions are only recorded from those explicit sources, because guessing them would break the provenance requirement.
- **Plugins load only from user-level config**, never repo config, so cloning a repo cannot execute code.

## Architecture
```
 Claude Code   Codex   Antigravity            git / working tree
      | documented hooks (stdin JSON)                 |
      v                                               v
 tokenistt hook <agent>  (fast path, always exit 0)   Indexer: git ls-files -> sha256
      | allowlist normaliser, redaction               |  tree-sitter wasm + SQL scanner
      v                                               |  framework analyzers -> relink
 .tokenistt/sessions/*.jsonl  (append only)           v
      |  ingest + dedupe                        .tokenistt/database/local.db
      +---------------------------------------> sessions | events | nodes | edges
                                                memory | FTS5 | optional vectors
                                                      |
        Retrieval: graph + FTS + vectors + sessions + memory
                                                      |
   +--------+--------+---------+-------+-----------+-------------+
   CLI      Ink TUI  Browser   Local   Context     Sync outbox
   --json            viewer    MCP     injection   (opt-in)
                     (loopback) stdio                  |
                                                       v
                        Gateway /v1/sync/*, /v1/admin/* -> Postgres -> Dashboard
```
Layering stays as it is today: `commands` -> `services` -> `api`, `store`, `graph`, `agents`. Commands use lazy imports so `hook` never loads Ink or tree-sitter.

```
cli/src/
  agents/{adapters/{claude-code,codex,antigravity},normalize,session-manager,capabilities,schemas}
  graph/{languages,parsers,sql,frameworks,linker,store,export,analysis}
  memory/  context/  retrieval/  impact/  sync/  mcp/  tui/  viewer/  plugins/
```

## Capability matrix (from docs; each cell is re-verified by tests before it is claimed)
| Capability | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Interface | hooks | hooks (`~/.codex` or `<repo>/.codex`) | hooks (`.agents/hooks.json`, `~/.gemini/config/hooks.json`) |
| Setup friction | settings edit | **user must trust hook in `/hooks`** | not documented; check at build |
| Session id | `session_id` | `session_id` | `conversationId` |
| Start / end | SessionStart, SessionEnd | SessionStart, SessionEnd | SessionStart, Stop (no end event) |
| Tools, files | PostToolUse, `tool_input` | PostToolUse | PostToolUse `toolCall` |
| Model | SessionStart `model`, optional | `model` | `modelName` |
| Tokens | transcript, **schema undocumented**; OTel documented | transcript, **schema undocumented** | **not documented: shown as unknown** |
| Cost | catalog estimate; OTel `cost_usd` is an estimate | catalog estimate | unknown |
| Context in | SessionStart `additionalContext` (over 10k chars goes to a file) | SessionStart stdout (limit ~2,500 tokens by default) | `.agents/rules/*.md`; SessionStart `injectSteps` |
| MCP | yes | yes | `.agents/mcp_config.json` |

**Limits**
- Never read Antigravity's `conversations/`, `*.db` or `*.pb`, or Codex's `*.sqlite` and `auth.json`.
- Read a transcript only at the `transcript_path` the hook provides. Extract only usage and model fields, tolerate unknown shapes, and label the source `transcript (best-effort)`. If the format changes, tokens become `unknown`, not wrong.
- Anything not exercised live ships as "documented, fixture-tested" in the matrix. Those need a live run before they are called verified.

**Cost labels:** `catalog_estimate` (tokens x versioned catalog), `agent_reported` (the agent's own estimate), `unknown`. Nothing is labelled provider-reported unless it really is. `pricing.ts` lists older model IDs, so newer models will show `unknown` until catalog entries are added. No prices are invented.

**Double counting:** usage dedupes on the request or message id from the transcript. If the agent's base URL points at the gateway, the session is marked `proxied` and its cost comes from the ledger alone.

## Key behaviours
- **Privacy:** normalising is allowlist-based. Prompts, file contents, tool output and `lastUserInput` are dropped by default. Commands are stored as program and subcommand only (`privacy.commands: none|name|redacted`). Prompt capture is opt-in.
- **Agent config edits:** `agents connect` shows a diff, asks for consent and writes a backup; `agents disconnect` removes only our entries. Instruction files are never overwritten. `context inject` writes our own file or hook by default. `--merge` edits a marked block in `AGENTS.md` after a preview.
- **Graph:** stable IDs (`file:path`, `sym:path#kind:name`), `schemaVersion` with migrations, source line ranges, deduped edges and reverse traversal. It stores no source text, and env vars by name only. Default excludes: `.env*`, keys, binaries, files over 1 MB, build output. `.gitignore` is respected through `git ls-files -co --exclude-standard`.
- **Incremental:** per-file hash -> cached extraction -> relink only affected importers. `fs.watch` with debounce.
- **Viewer:** Cytoscape with module-level clusters that expand on demand, so large repos never render everything. Binds to 127.0.0.1 on a random port with a URL token and Host check, and is read-only.
- **TUI:** alternate screen with restore on exit, Ctrl+C and errors. Progress comes from real counts only. Honours `CI`, non-TTY and `TOKENISTT_REDUCED_MOTION`. Bare `tokenistt` in a non-TTY prints status and exits.
- **Sync:** opt-in, idempotent outbox, repo-relative paths only, memory summaries by default.

## Stacked PRs
Each PR: reproduce CI in a `node:20` container (plus Node 22 for `cli`), regenerate the lockfile there, push, wait for green CI, then branch the next PR from it.

| # | Milestone | PR |
|---|---|---|
| 1 | P0 | Existing foundation + updated `docs/cli/PLAN.md` + `CLAUDE.md` stage note |
| 2 | P0 | Node 22 job, `init`, project detection, `.tokenistt/`, SQLite migrations, progress renderer |
| 3 | P1 | **Parser spike first** (`web-tree-sitter` vs `tree-sitter-wasms` ABI; pin older if needed), graph schema, TS/JS/Python/JSON/YAML/SQL, `map`, export |
| 4 | P1 | Java, Go, Rust, PHP, C#, C/C++ |
| 5 | P1 | Incremental, watch, `--stats`, import, schema migration |
| 6 | P1 | Analyzers: Express, Next, React, Node, Drizzle, Postgres, Prisma, then NestJS, FastAPI, Django, Spring, Supabase |
| 7 | P1 | `graph --open` viewer and terminal overview |
| 8 | P2 | Agent layer, hook fast path, Claude adapter, `agents connect/disconnect` |
| 9 | P2 | Codex and Antigravity adapters, published capability matrix |
| 10 | P2 | `sessions *`, `watch`, usage attribution |
| 11 | P3 | Memory engine: categories, extraction, history, contradiction and stale handling, `memory *` |
| 12 | P3 | `context`, `context inject/preview`, local `tokenistt mcp` |
| 13 | P4 | `impact`, `changes` |
| 14 | P4 | Retrieval, graph analyses (cycles, coupling, duplicates, flows), optional embeddings |
| 15 | P4 | Ink dashboard and navigation |
| 16 | P5 | Migration `0013`, `/v1/sync/*`, `/v1/admin/agent-sessions`, repositories, memories, with isolation tests and OpenAPI |
| 17 | P5 | `sync`, outbox, ledger opt-in |
| 18 | P5 | `usage`, `cost`, `models`, `providers`, `policy`, `optimize` (rules-based, on `/usage/summary`) |
| 19 | P5 | Dashboard pages via the `/api/gateway` proxy: agent activity, sessions, graph, memory |
| 20 | P5 | Plugin docs, `README` and `CLAUDE.md` gaps, npm release workflow |

**Reuse:** `ApiClient`, `Output`, `core/redact.ts`, `core/errors.ts`, `config/store.ts`, the ingest route's auth and rate-limit pattern, the management `endpoint()` RBAC wrapper, and `transactions.metadata->>'session'` grouping. Existing `apps/mcp-server` stays unchanged. It reads the running stack; the new local MCP reads `.tokenistt`.

**Risks**
- Stacking 20 unmerged PRs means review feedback on an early one rebases everything above it. Reviewing and merging in order keeps this small.
- Twelve framework analyzers is the part most likely to run thin. Any without passing tests is listed as unsupported, not shipped as claimed.
- The Windows hook path needs care: small atomic appends and no shell quoting traps.

## Verification
- **Per PR:** `npm run typecheck && npm run build && npm test`, plus `npm run test:e2e -w apps/gateway` when the gateway changes. Tests follow the repo's `node:test` + `tsx` pattern, covering each subsystem.
- **Language support:** a fixture repo per language asserting exact symbols and edges. The support table in the docs only lists passing languages.
- **Representative repos:** this monorepo, plus one public repo each in Python and Go. Record real index time and node counts in the PR.
- **Agents:** run a real Claude Code session with hooks installed and compare captured events with the transcript. Codex and Antigravity use doc-derived fixtures; a live run on a machine with them installed is still required before they are called verified.
- **TUI:** `ink-testing-library` for navigation and resize, and a spawned process for signal cleanup and non-TTY.
- **End to end (PR 20):** walk the 16 acceptance criteria in order on a clean clone, with the network disabled for the local ones. Report any that did not pass.

## Sources
[Claude Code hooks](https://code.claude.com/docs/en/hooks), [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage), [Codex hooks](https://learn.chatgpt.com/docs/hooks.md), [Antigravity hooks](https://antigravity.google/docs/hooks), [rules](https://antigravity.google/docs/rules), [MCP](https://antigravity.google/docs/mcp), [Antigravity CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md), [tree-sitter-wasms files](https://app.unpkg.com/tree-sitter-wasms@0.1.13/files/out)
