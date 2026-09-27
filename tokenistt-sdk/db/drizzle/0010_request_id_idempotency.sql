-- =============================================================================
-- 0010_request_id_idempotency.sql
-- Add UNIQUE index on transactions.request_id to enforce idempotency.
--
-- Background: drainQueue() uses ON CONFLICT (request_id) DO NOTHING to
-- safely replay queued transactions. Without a unique index, that clause
-- throws a PostgreSQL error at runtime:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
-- This also prevents duplicate billing from retries and queue replays.
--
-- PARTITIONED TABLE CONSTRAINT: PostgreSQL requires unique indexes on
-- partitioned tables to include all partitioning columns. The transactions
-- table is partitioned by created_at, so a global unique on request_id alone
-- is not possible without including created_at.
--
-- WORKAROUND (two-part fix):
-- 1. Create a regular (non-unique) btree index on request_id for fast lookups.
-- 2. Rewrite drainQueue() to use INSERT ... WHERE NOT EXISTS (...) instead
--    of ON CONFLICT (request_id) DO NOTHING. The WHERE NOT EXISTS check
--    performs a fast index scan on request_id across all partitions.
-- =============================================================================

-- Fast lookup index for idempotency checks in drainQueue / transactionLogger
CREATE INDEX IF NOT EXISTS ix_txn_request_id_lookup
  ON transactions (request_id)
  WHERE request_id IS NOT NULL;
