-- =============================================================================
-- 0009_alerts.sql
-- Budget alerts and anomaly notifications ledger.
-- =============================================================================

CREATE TABLE IF NOT EXISTS budget_alerts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  budget_id       bigint REFERENCES budgets(id) ON DELETE CASCADE,
  virtual_key_id  bigint REFERENCES virtual_keys(id) ON DELETE SET NULL,
  severity        text NOT NULL CHECK (severity IN ('warn', 'critical', 'exceeded')),
  title           text NOT NULL,
  message         text NOT NULL,
  channels        jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_budget_alerts_org_created 
  ON budget_alerts (organization_id, created_at DESC);

