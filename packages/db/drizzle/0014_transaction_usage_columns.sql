-- =============================================================================
-- 0014_transaction_usage_columns.sql
-- First-class columns for facts that used to live only in transactions.metadata JSON (or nowhere):
--   reasoning_tokens  reasoning tokens, already included in completion_tokens (kept for visibility/pricing)
--   cost_status       'ok' | 'COST_UNAVAILABLE' | 'NOT_APPLICABLE'. Lets analytics count unpriced spend
--                     instead of treating $0.00 rows as free.
--   tokens_estimated  true when the provider reported no usage and the counts are our own estimate
-- Constant defaults make this a metadata-only change on PostgreSQL 11+ (no table rewrite). Existing rows
-- keep the defaults; nothing is updated, so the immutability of `transactions` is preserved.
-- =============================================================================

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS reasoning_tokens  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_status       text    NOT NULL DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS tokens_estimated  boolean NOT NULL DEFAULT false;
