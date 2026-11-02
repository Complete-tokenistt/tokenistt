# What Tokenistt can observe per coding agent

Agents expose different things, so nothing here assumes they're alike. `tokenistt agents capabilities` prints the same table from the code.

**Supported** means the agent documents it. **Best-effort** means it works but rests on a heuristic or an undocumented format. **Unsupported** means it isn't available, and shows as unknown rather than being estimated.

| | Claude Code | OpenAI Codex | Google Antigravity |
|---|---|---|---|
| Sessions | Supported | Supported | Best-effort: no end event |
| Tasks | Supported | Supported | Supported |
| File changes | Supported | Best-effort: from patch headers, and reads aren't reported | Supported |
| Commands | Supported | Supported | Supported |
| Tools | Supported | Supported, except hosted tools | Supported |
| Errors | Supported | Unsupported | Supported |
| Tests | Best-effort | Best-effort, pass or fail unknown | Best-effort |
| Model | Best-effort | Supported | Supported |
| Tokens | Best-effort: undocumented transcript | Unsupported | Unsupported |
| Cost | Best-effort: estimated | Unsupported | Unsupported |
| Context injection | Supported | Supported | Supported |

## How far each one has been checked

| Agent | Status |
|---|---|
| Claude Code | One real session, run with `claude -p` on Windows. Resuming, test runs, deletions and failures are checked against fixtures only. |
| OpenAI Codex | Written from the documentation and checked against fixtures. **Not yet run against the real agent.** |
| Google Antigravity | Written from the documentation and checked against fixtures. **Not yet run against the real agent.** |

If you try Codex or Antigravity and something doesn't match, please open an issue with the output of `tokenistt agents capabilities`.

## Setting up each agent

| Agent | Command | Writes to | You also need to |
|---|---|---|---|
| Claude Code | `tokenistt agents connect claude-code` | `.claude/settings.local.json`, or `~/.claude/settings.json` with `--user` | Nothing |
| OpenAI Codex | `tokenistt agents connect codex` | `.codex/hooks.json`, or `~/.codex/hooks.json` with `--user` | Trust the hook with `/hooks` in Codex. A project hook also needs the project trusted |
| Google Antigravity | `tokenistt agents connect antigravity` | `.agents/hooks.json`, or `~/.gemini/config/hooks.json` with `--user` | Start a new conversation |

Hook files hold absolute paths for your machine, so don't commit them. `.claude/settings.local.json` is already ignored by Claude Code; add the others to your `.gitignore` if you use project scope.

## What is never read

- Antigravity's conversation databases and protobuf files
- Codex's SQLite databases and `auth.json`
- Any agent's credentials

A transcript is only read for Claude Code, only at the path its hook provides, and only for usage and model fields.

## Adding an agent

Implement `AgentAdapter` in `cli/src/agents/adapter.ts` and list it in `cli/src/agents/registry.ts`. Use only interfaces the agent documents, and mark anything you haven't verified as such.
