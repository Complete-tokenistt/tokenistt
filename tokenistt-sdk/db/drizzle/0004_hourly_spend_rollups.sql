-- =============================================================================
-- 0004_hourly_spend_rollups.sql
-- Materialized hourly aggregation rollups for high-throughput FinOps analytics.
-- =============================================================================

CREATE TABLE IF NOT EXISTS hourly_spend (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id         bigint REFERENCES teams(id) ON DELETE SET NULL,
  project_id      bigint REFERENCES projects(id) ON DELETE SET NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  hour_bucket     timestamptz NOT NULL,
  request_count   integer NOT NULL DEFAULT 0,
  total_tokens    bigint NOT NULL DEFAULT 0,
  input_tokens    bigint NOT NULL DEFAULT 0,
  output_tokens   bigint NOT NULL DEFAULT 0,
  cost_usd        numeric(18,6) NOT NULL DEFAULT 0,
  error_count     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_hourly_spend_org_bucket
  ON hourly_spend (organization_id, hour_bucket DESC);

CREATE INDEX IF NOT EXISTS ix_hourly_spend_team_bucket
  ON hourly_spend (organization_id, team_id, hour_bucket DESC);

CREATE INDEX IF NOT EXISTS ix_hourly_spend_project_bucket
  ON hourly_spend (organization_id, project_id, hour_bucket DESC);

