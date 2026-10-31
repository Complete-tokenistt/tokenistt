-- =============================================================================
-- 0011_oss_core.sql
-- Provider keys (BYOK), routing rules, audit trails, approvals, connectors,
-- cost attribution dimensions and request replays.
-- =============================================================================

-- BYOK provider keys (multiple per provider, priority + failover)
CREATE TABLE IF NOT EXISTS provider_keys (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id    bigint REFERENCES workspaces(id) ON DELETE CASCADE,
    provider        text NOT NULL,
    label           text NOT NULL DEFAULT 'default',
    encrypted_key   text NOT NULL,
    priority        integer NOT NULL DEFAULT 100,
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled','failing')),
    last_error      text,
    last_used_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_provider_keys_lookup
    ON provider_keys (organization_id, provider, status, priority);

-- Routing rules
CREATE TABLE IF NOT EXISTS routing_rules (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            text NOT NULL,
    priority        integer NOT NULL DEFAULT 100,
    strategy        text NOT NULL
                    CHECK (strategy IN ('cheapest','fastest','policy','fallback')),
    match           jsonb NOT NULL DEFAULT '{}'::jsonb,
    targets         jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_enabled      boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_routing_rules_org
    ON routing_rules (organization_id, is_enabled, priority);

-- Immutable audit trails
-- policy_audit_log: automated decisions (policy / budget / routing) per request.
CREATE TABLE IF NOT EXISTS policy_audit_log (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint REFERENCES organizations(id) ON DELETE SET NULL,
    kind            text NOT NULL CHECK (kind IN ('policy','budget','routing')),
    subject_id      text,
    request_id      text,
    decision        text NOT NULL,
    reason          text,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_policy_audit_org_created
    ON policy_audit_log (organization_id, created_at DESC);

-- audit_log: admin actions (key creation, budget edits, policy changes ...).
CREATE TABLE IF NOT EXISTS audit_log (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id bigint REFERENCES organizations(id) ON DELETE SET NULL,
    actor           text NOT NULL,
    action          text NOT NULL,
    entity_type     text,
    entity_id       text,
    before          jsonb,
    after           jsonb,
    ip              text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_log_org_created
    ON audit_log (organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION tokenistt_block_mutation() RETURNS trigger AS $fn$
BEGIN
    RAISE EXCEPTION '% is append-only: % not allowed', TG_TABLE_NAME, TG_OP;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_policy_audit_immutable ON policy_audit_log;
CREATE TRIGGER trg_policy_audit_immutable
    BEFORE UPDATE OR DELETE ON policy_audit_log
    FOR EACH ROW EXECUTE FUNCTION tokenistt_block_mutation();

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;
CREATE TRIGGER trg_audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION tokenistt_block_mutation();

-- Approval workflow (policy action: require_approval)
CREATE TABLE IF NOT EXISTS approval_requests (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    policy_id       bigint REFERENCES policies(id) ON DELETE SET NULL,
    request_fingerprint text NOT NULL,
    requester       text,
    model           text,
    reason          text,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','denied','expired')),
    decided_by      text,
    decided_at      timestamptz,
    expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_approvals_org_status
    ON approval_requests (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_approvals_fingerprint
    ON approval_requests (organization_id, request_fingerprint, status);

-- Connectors (GitHub, Jira, Slack, ...)
CREATE TABLE IF NOT EXISTS connectors (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    type            text NOT NULL,
    name            text NOT NULL,
    encrypted_config text NOT NULL,
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','error')),
    last_sync_at    timestamptz,
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS connector_sync_runs (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    connector_id    bigint NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    status          text NOT NULL CHECK (status IN ('running','success','error')),
    entities_synced integer NOT NULL DEFAULT 0,
    error           text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz
);

-- Entities pulled from connectors; matched to spend by dimension + external_id
CREATE TABLE IF NOT EXISTS connector_entities (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    connector_id    bigint NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    dimension       text NOT NULL CHECK (dimension IN ('repo','ticket','sprint','feature','customer','employee','deployment','channel')),
    external_id     text NOT NULL,
    name            text,
    data            jsonb NOT NULL DEFAULT '{}'::jsonb,
    synced_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connector_id, dimension, external_id)
);
CREATE INDEX IF NOT EXISTS ix_connector_entities_lookup
    ON connector_entities (organization_id, dimension, external_id);

-- Cost attribution dimensions on every transaction
ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS repo     text,
    ADD COLUMN IF NOT EXISTS ticket   text,
    ADD COLUMN IF NOT EXISTS sprint   text,
    ADD COLUMN IF NOT EXISTS feature  text,
    ADD COLUMN IF NOT EXISTS customer text,
    ADD COLUMN IF NOT EXISTS employee text;

CREATE INDEX IF NOT EXISTS ix_txn_feature_created  ON transactions (feature, created_at DESC)  WHERE feature  IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_txn_repo_created     ON transactions (repo, created_at DESC)     WHERE repo     IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_txn_customer_created ON transactions (customer, created_at DESC) WHERE customer IS NOT NULL;

-- Spend per attribution dimension (uses connector entity names when synced)
CREATE OR REPLACE VIEW v_cost_by_dimension AS
SELECT t.organization_id, d.dimension, d.value,
       COALESCE(e.name, d.value)         AS label,
       SUM(t.cost_usd)                   AS cost_usd,
       SUM(t.total_tokens)               AS total_tokens,
       COUNT(*)                          AS requests,
       MIN(t.created_at)                 AS first_seen,
       MAX(t.created_at)                 AS last_seen
FROM transactions t
CROSS JOIN LATERAL (VALUES
    ('repo', t.repo), ('ticket', t.ticket), ('sprint', t.sprint),
    ('feature', t.feature), ('customer', t.customer), ('employee', COALESCE(t.employee, t.actor))
) AS d(dimension, value)
LEFT JOIN connector_entities e
       ON e.organization_id = t.organization_id AND e.dimension = d.dimension AND e.external_id = d.value
WHERE d.value IS NOT NULL
GROUP BY t.organization_id, d.dimension, d.value, e.name;

-- Request replays
CREATE TABLE IF NOT EXISTS request_replays (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    transaction_public_id uuid NOT NULL,
    requested_by    text,
    result_status   text,
    new_request_id  text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
