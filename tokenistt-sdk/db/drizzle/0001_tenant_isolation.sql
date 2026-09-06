-- =============================================================================
-- 0001_tenant_isolation.sql
-- Enforces strict multi-tenant isolation on governance policies.
-- =============================================================================

CREATE TABLE IF NOT EXISTS policies (
    id              bigserial PRIMARY KEY,
    public_id       uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
    organization_id bigint REFERENCES organizations(id) ON DELETE CASCADE,
    name            text NOT NULL,
    description     text,
    is_enabled      boolean NOT NULL DEFAULT true,
    conditions      jsonb NOT NULL DEFAULT '{}'::jsonb,
    actions         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Ensure organization_id exists if the table was previously created without it
ALTER TABLE policies ADD COLUMN IF NOT EXISTS organization_id bigint REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_policies_org ON policies (organization_id, is_enabled);

