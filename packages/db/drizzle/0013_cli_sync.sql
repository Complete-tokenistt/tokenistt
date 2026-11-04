-- Summaries the CLI syncs from a repository, when sync is switched on. Agent sessions live apart from `transactions`:
-- subscription usage is not spend, and these tables must not feed budgets. Nothing here holds source code, prompts
-- or machine paths.
CREATE TABLE IF NOT EXISTS code_repositories (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_key     text NOT NULL,
    name            text NOT NULL,
    branch          text,
    commit_sha      text,
    graph_stats     jsonb,
    graph_modules   jsonb,
    last_synced_at  timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, project_key)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    repository_id   bigint NOT NULL REFERENCES code_repositories(id) ON DELETE CASCADE,
    agent           text NOT NULL,
    session_id      text NOT NULL,
    branch          text,
    state           text NOT NULL,
    started_at      timestamptz NOT NULL,
    ended_at        timestamptz,
    last_event_at   timestamptz NOT NULL,
    models          text[] NOT NULL DEFAULT '{}',
    -- NULL means the agent did not report it, which is different from zero.
    tokens          jsonb,
    cost_usd        numeric(18,8),
    cost_source     text NOT NULL DEFAULT 'unknown' CHECK (cost_source IN ('catalog_estimate', 'unknown')),
    counts          jsonb NOT NULL DEFAULT '{}',
    changed_files   jsonb NOT NULL DEFAULT '[]',
    UNIQUE (organization_id, repository_id, agent, session_id)
);
CREATE INDEX IF NOT EXISTS ix_agent_sessions_recent ON agent_sessions (organization_id, last_event_at DESC);

CREATE TABLE IF NOT EXISTS repository_memories (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    repository_id   bigint NOT NULL REFERENCES code_repositories(id) ON DELETE CASCADE,
    memory_key      text NOT NULL,
    category        text NOT NULL,
    content         text NOT NULL,
    source_kind     text NOT NULL,
    source_ref      text NOT NULL,
    status          text NOT NULL,
    updated_at      timestamptz NOT NULL,
    UNIQUE (organization_id, repository_id, memory_key)
);
CREATE INDEX IF NOT EXISTS ix_repository_memories_category ON repository_memories (organization_id, repository_id, category);
