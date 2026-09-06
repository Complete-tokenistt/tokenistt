-- =============================================================================
-- 0003_budgets_and_attribution.sql
-- Teams, Projects, and Multi-level Budget Governance
-- =============================================================================

-- Teams (Engineering, Customer Support, etc.)
CREATE TABLE IF NOT EXISTS teams (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            text NOT NULL,
    slug            text NOT NULL,
    cost_center     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug)
);

-- Projects (Copilot, RAG Service, Support Bot, etc.)
CREATE TABLE IF NOT EXISTS projects (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    team_id         bigint REFERENCES teams(id) ON DELETE SET NULL,
    name            text NOT NULL,
    slug            text NOT NULL,
    environment     text NOT NULL DEFAULT 'production',
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug)
);

-- Multi-level Budgets (Organization, Team, Project, or Virtual Key)
CREATE TABLE IF NOT EXISTS budgets (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id            uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id      bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    scope_type           text NOT NULL CHECK (scope_type IN ('organization','team','project','virtual_key')),
    scope_id             bigint NOT NULL,
    name                 text,
    cap_usd              numeric(18,2) NOT NULL,
    period               text NOT NULL DEFAULT 'monthly'
                         CHECK (period IN ('none','daily','weekly','monthly')),
    warn_threshold_pct   numeric(5,2) NOT NULL DEFAULT 80.0,
    critical_threshold_pct numeric(5,2) NOT NULL DEFAULT 90.0,
    enforcement_mode     text NOT NULL DEFAULT 'hard_cap'
                         CHECK (enforcement_mode IN ('alert_only','auto_throttle','hard_cap')),
    is_active            boolean NOT NULL DEFAULT true,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_budgets_scope 
    ON budgets (organization_id, scope_type, scope_id, is_active);

-- Link teams and projects to transactions ledger
ALTER TABLE transactions 
    ADD COLUMN IF NOT EXISTS team_id bigint REFERENCES teams(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS project_id bigint REFERENCES projects(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS environment text,
    ADD COLUMN IF NOT EXISTS application text;

CREATE INDEX IF NOT EXISTS ix_txn_team_created   ON transactions (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_txn_project_created ON transactions (project_id, created_at DESC);

