-- =============================================================================
-- 0007_pricing_history.sql
-- Point-in-time pricing validity ranges and cache write pricing tiers.
-- =============================================================================

ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS effective_to date;
ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS cache_write_price_per_1m numeric(18,8);

CREATE INDEX IF NOT EXISTS ix_model_catalog_effective 
  ON model_catalog (provider, model_id, effective_from, effective_to);
