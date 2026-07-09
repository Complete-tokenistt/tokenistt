-- =============================================================================
-- tokenistt — Materialized views & FinOps rollups
-- Run with:  psql "$DATABASE_URL" -f db/drizzle/views.sql
--
-- Materialized views pre-aggregate the (partitioned, append-only) transactions
-- table so dashboards and cost-center rollups stay fast at scale. Each has a
-- UNIQUE index so it can be refreshed CONCURRENTLY (no read locks).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Daily cost by provider  →  "Total cost by provider for CFO dashboard"
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cost_by_provider_daily AS
SELECT
    date_trunc('day', created_at)::date AS day,
    provider,
    count(*)                           AS call_count,
    sum(total_tokens)                  AS total_tokens,
    sum(cost_usd)                     AS cost_usd,
    sum(amortized_cost_usd)           AS amortized_cost_usd,
    sum(input_cost_usd)               AS input_cost_usd,
    sum(output_cost_usd)              AS output_cost_usd
FROM transactions
GROUP BY 1, 2;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_provider_daily
    ON mv_cost_by_provider_daily (day, provider);

-- -----------------------------------------------------------------------------
-- Daily cost by cost center  →  FinOps rollup / budget variance
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cost_by_cost_center_daily AS
SELECT
    date_trunc('day', created_at)::date AS day,
    organization_id,
    workspace_id,
    cost_center,
    count(*)              AS call_count,
    sum(cost_usd)         AS cost_usd,
    sum(amortized_cost_usd) AS amortized_cost_usd
FROM transactions
GROUP BY 1, 2, 3, 4;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_cc_daily
    ON mv_cost_by_cost_center_daily (day, organization_id, workspace_id, cost_center);

-- -----------------------------------------------------------------------------
-- Daily cost by workspace
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cost_by_workspace_daily AS
SELECT
    date_trunc('day', created_at)::date AS day,
    organization_id,
    workspace_id,
    count(*)              AS call_count,
    sum(cost_usd)         AS cost_usd,
    sum(amortized_cost_usd) AS amortized_cost_usd
FROM transactions
GROUP BY 1, 2, 3;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_ws_daily
    ON mv_cost_by_workspace_daily (day, organization_id, workspace_id);

-- -----------------------------------------------------------------------------
-- Daily cost by actor  →  "Sarah's spend" leaderboards
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cost_by_actor_daily AS
SELECT
    date_trunc('day', created_at)::date AS day,
    organization_id,
    actor,
    count(*)       AS call_count,
    sum(cost_usd)  AS cost_usd
FROM transactions
GROUP BY 1, 2, 3;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_actor_daily
    ON mv_cost_by_actor_daily (day, organization_id, actor);

-- -----------------------------------------------------------------------------
-- Virtual key monthly spend  →  budget-cap enforcement
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_virtual_key_spend_monthly AS
SELECT
    virtual_key_id,
    date_trunc('month', created_at)::date AS month,
    count(*)              AS call_count,
    sum(cost_usd)         AS spend_usd,
    sum(amortized_cost_usd) AS amortized_usd
FROM transactions
WHERE virtual_key_id IS NOT NULL
GROUP BY 1, 2;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_vk_spend
    ON mv_virtual_key_spend_monthly (virtual_key_id, month);

-- -----------------------------------------------------------------------------
-- Provider reconciliation  →  ledger cost vs. actual vendor invoice
-- Invoices are pre-aggregated per (org, provider, month) so a month with
-- multiple invoices can't multiply the ledger rows (which would break the
-- unique index and inflate sums).
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_provider_reconciliation AS
WITH inv AS (
    SELECT
        organization_id,
        provider,
        date_trunc('month', period_start)::date AS month,
        sum(billed_amount_usd) AS billed_amount_usd
    FROM provider_invoices
    GROUP BY organization_id, provider, date_trunc('month', period_start)::date
)
SELECT
    t.organization_id,
    t.provider,
    date_trunc('month', t.created_at)::date AS month,
    sum(t.cost_usd)                                  AS ledger_cost_usd,
    coalesce(i.billed_amount_usd, 0)                 AS invoice_amount_usd,
    sum(t.cost_usd) - coalesce(i.billed_amount_usd, 0) AS variance_usd,
    CASE
        WHEN abs(sum(t.cost_usd) - coalesce(i.billed_amount_usd, 0)) <= 0.01 THEN 'matched'
        WHEN i.billed_amount_usd IS NULL THEN 'no_invoice'
        ELSE 'variance'
    END AS status
FROM transactions t
LEFT JOIN inv i
       ON i.organization_id = t.organization_id
      AND i.provider        = t.provider
      AND date_trunc('month', t.created_at) = i.month
GROUP BY t.organization_id, t.provider, month, i.billed_amount_usd;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_recon
    ON mv_provider_reconciliation (organization_id, provider, month);

-- -----------------------------------------------------------------------------
-- Refresh (CONCURRENTLY ⇒ no read locks). Schedule via pg_cron or your runner:
--
--   SELECT cron.schedule('refresh_tokenistt_mv', '*/15 * * * *', $$
--     REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cost_by_provider_daily;
--     REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cost_by_cost_center_daily;
--     REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cost_by_workspace_daily;
--     REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cost_by_actor_daily;
--     REFRESH MATERIALIZED VIEW CONCURRENTLY mv_virtual_key_spend_monthly;
--     REFRESH MATERIALIZED VIEW CONCURRENTLY mv_provider_reconciliation;
--   $$);
--
-- Or one-shot:
-- -----------------------------------------------------------------------------
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cost_by_provider_daily;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cost_by_cost_center_daily;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cost_by_workspace_daily;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cost_by_actor_daily;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_virtual_key_spend_monthly;
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_provider_reconciliation;
