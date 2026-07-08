-- =============================================================================
-- tokenistt — Transaction Ledger Schema (Phase 3)
-- Financial-grade AI usage tracking with cost-center rollups.
--
-- Run with:  psql "$DATABASE_URL" -f db/drizzle/0000_init.sql
-- Requires: PostgreSQL 13+ (generated identity, BRIN, partial/composite indexes).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. organizations  (multi-tenant root)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id   uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    name        text        NOT NULL,
    slug        text        NOT NULL UNIQUE,
    plan        text        NOT NULL DEFAULT 'free',
    settings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. users  (people dimension — required for "Sarah's spend" attribution)
--    The SDK sends an arbitrary `user` string; we resolve it to a directory
--    row when possible and also keep the raw `actor` on every transaction.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id      uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email          text,
    display_name   text,
    external_ref   text,                       -- IdP subject / SSO id
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, external_ref)
);

-- -----------------------------------------------------------------------------
-- 3. workspaces  (teams / cost centers)
--    `cost_center` is the accounting code, e.g. "CC-4401-Support".
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            text        NOT NULL,
    cost_center     text        NOT NULL,       -- "CC-4401-Support"
    budget_cap_usd  numeric(18,2),              -- optional soft/hard cap
    billing_email   text,
    metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, cost_center)
);

-- -----------------------------------------------------------------------------
-- 4. virtual_keys  (API key management with budget caps)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS virtual_keys (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id  bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id     bigint      REFERENCES workspaces(id) ON DELETE SET NULL,
    owner_user_id    bigint      REFERENCES users(id) ON DELETE SET NULL,
    created_by       bigint      REFERENCES users(id) ON DELETE SET NULL,
    name             text        NOT NULL,
    key_prefix       text        NOT NULL,                  -- "tk_live_8f2c" (for display)
    key_hash         text        NOT NULL,                  -- scrypt/bcrypt of the secret
    budget_cap_usd   numeric(18,2),                         -- per-key cap
    budget_period    text        NOT NULL DEFAULT 'monthly' -- none | daily | monthly
                    CHECK (budget_period IN ('none','daily','monthly')),
    allowed_providers text[],                              -- optional allowlist
    status           text        NOT NULL DEFAULT 'active'  -- active | revoked | expired
                    CHECK (status IN ('active','revoked','expired')),
    last_used_at     timestamptz,
    expires_at       timestamptz,
    revoked_at       timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ix_vk_org_status ON virtual_keys (organization_id, status);

-- -----------------------------------------------------------------------------
-- 5. transactions  (every single API call — the financial ledger)
--    Partitioned by month on created_at for retention + time-range scans.
--    PK must include the partition key (created_at).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    id                  bigint GENERATED ALWAYS AS IDENTITY,
    public_id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    organization_id     bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id        bigint      REFERENCES workspaces(id) ON DELETE SET NULL,
    virtual_key_id      bigint      REFERENCES virtual_keys(id) ON DELETE SET NULL,
    user_id             bigint      REFERENCES users(id) ON DELETE SET NULL,
    actor               text,                           -- SDK `user` attribution (e.g. sarah@x.com)
    provider            text        NOT NULL,           -- openai | anthropic | tokenistt-gateway
    model               text        NOT NULL,           -- gpt-4o
    endpoint            text        NOT NULL DEFAULT '/chat/completions',
    request_id          text,                           -- gateway request id
    cost_center         text        NOT NULL,           -- accounting code captured at call time
    project_tag         text,                           -- optional granular tracking
    currency            char(3)     NOT NULL DEFAULT 'USD',

    -- --- FinOps money fields: EXACT decimals, never float ---
    cost_usd            numeric(18,6) NOT NULL CHECK (cost_usd >= 0),
    amortized_cost_usd  numeric(18,6) NOT NULL DEFAULT 0 CHECK (amortized_cost_usd >= 0),
    input_cost_usd      numeric(18,6) NOT NULL DEFAULT 0,
    output_cost_usd     numeric(18,6) NOT NULL DEFAULT 0,

    -- --- token accounting ---
    prompt_tokens       integer NOT NULL DEFAULT 0,
    completion_tokens   integer NOT NULL DEFAULT 0,
    total_tokens        integer NOT NULL DEFAULT 0,
    cache_creation_tokens integer NOT NULL DEFAULT 0,  -- prompt-cache WRITE tokens
    cache_read_tokens   integer NOT NULL DEFAULT 0,    -- prompt-cache READ tokens

    status              text        NOT NULL DEFAULT 'success'
                        CHECK (status IN ('success','error','timeout','rate_limited')),
    error_code          text,
    shadow_ai_flag      boolean     NOT NULL DEFAULT false,  -- detected outside approved channels
    duration_ms         integer,
    metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Indexes tuned for the two headline queries + general rollups.
-- (On a partitioned table these are created on every partition automatically.)
CREATE INDEX IF NOT EXISTS ix_txn_costcenter_actor_created
    ON transactions (cost_center, actor, created_at DESC);          -- "Sarah in Support, last week"
CREATE INDEX IF NOT EXISTS ix_txn_workspace_created
    ON transactions (workspace_id, created_at DESC);                 -- team rollups
CREATE INDEX IF NOT EXISTS ix_txn_actor_created
    ON transactions (actor, created_at DESC);                        -- per-user dashboards
CREATE INDEX IF NOT EXISTS ix_txn_provider_created
    ON transactions (provider, created_at DESC);                     -- "cost by provider" (CFO)
CREATE INDEX IF NOT EXISTS ix_txn_shadow_created
    ON transactions (created_at DESC) WHERE shadow_ai_flag = true;   -- partial: shadow AI
CREATE INDEX IF NOT EXISTS ix_txn_project_created
    ON transactions (project_tag, created_at DESC) WHERE project_tag IS NOT NULL;  -- partial
CREATE INDEX IF NOT EXISTS ix_txn_public_id
    ON transactions (public_id);
-- BRIN is ideal for append-only time-series on huge tables (cheap, order-preserving).
CREATE INDEX IF NOT EXISTS ix_txn_created_brin
    ON transactions USING BRIN (created_at) WITH (pages_per_range = 32);

-- Default partition catches anything outside pre-created ranges.
CREATE TABLE IF NOT EXISTS transactions_default PARTITION OF transactions DEFAULT;

-- -----------------------------------------------------------------------------
-- 6. provider_invoices  (reconciliation with actual vendor bills)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_invoices (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id         uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id   bigint      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider          text        NOT NULL,
    invoice_number    text,
    invoice_date      date        NOT NULL,
    period_start      date        NOT NULL,
    period_end        date        NOT NULL,
    currency          char(3)     NOT NULL DEFAULT 'USD',
    billed_amount_usd numeric(18,2) NOT NULL,
    tax_usd           numeric(18,2) NOT NULL DEFAULT 0,
    credits_usd       numeric(18,2) NOT NULL DEFAULT 0,
    net_amount_usd    numeric(18,2) NOT NULL,
    document_url      text,
    status            text        NOT NULL DEFAULT 'received'  -- received | reconciled | disputed
                      CHECK (status IN ('received','reconciled','disputed')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (organization_id, provider, invoice_number)
);
CREATE INDEX IF NOT EXISTS ix_inv_provider_period
    ON provider_invoices (provider, period_start, period_end);

-- -----------------------------------------------------------------------------
-- Auto-create monthly partitions (call from pg_cron or app startup).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ensure_transactions_partition(for_date timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    start_dt timestamptz := date_trunc('month', for_date);
    end_dt   timestamptz := start_dt + interval '1 month';
    part     text := 'transactions_y' || to_char(start_dt, 'YYYY')
                   || 'm' || to_char(start_dt, 'MM');
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF transactions FOR VALUES FROM (%L) TO (%L)',
            part, start_dt, end_dt);
    END IF;
END;
$$;

-- Seed the current and next two months so ingestion never lands in DEFAULT.
SELECT ensure_transactions_partition(date_trunc('month', now()));
SELECT ensure_transactions_partition(date_trunc('month', now()) + interval '1 month');
SELECT ensure_transactions_partition(date_trunc('month', now()) + interval '2 month');

-- Optional: keep `organizations.updated_at` fresh.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_orgs_updated ON organizations;
CREATE TRIGGER trg_orgs_updated BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
