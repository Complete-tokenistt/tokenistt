-- =============================================================================
-- 0005_unit_economics.sql
-- Tracking business units (cost per customer, ticket, document, transaction)
-- =============================================================================

CREATE TABLE IF NOT EXISTS unit_metrics (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      bigint REFERENCES projects(id) ON DELETE SET NULL,
  metric_name     text NOT NULL,      -- "tickets", "customers", "documents", "transactions"
  feature_tag     text,
  metric_count    integer NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_unit_metrics_org 
  ON unit_metrics (organization_id, period_start DESC);

