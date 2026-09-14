-- =============================================================================
-- 0008_hourly_spend_upsert.sql
-- Adds unique index for atomic hourly rollup upsert operations.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_hourly_spend_bucket
  ON hourly_spend (organization_id, provider, model, hour_bucket);
