-- =============================================================================
-- tokenistt — Sample FinOps & analytics queries
-- Run with:  psql "$DATABASE_URL" -f db/drizzle/queries.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Q1. "Sarah's spend in the Support team last week"
--     Uses the composite index (cost_center, actor, created_at).
--     `cost_center` is stored denormalized on each transaction, so no JOIN
--     is required; the workspace JOIN is optional (e.g. to resolve the name).
-- -----------------------------------------------------------------------------
SELECT
    date_trunc('day', t.created_at)::date AS day,
    sum(t.cost_usd)           AS cost_usd,
    sum(t.amortized_cost_usd) AS amortized_usd,
    count(*)                  AS calls,
    sum(t.total_tokens)       AS tokens
FROM transactions t
-- JOIN workspaces w ON w.id = t.workspace_id          -- optional, to resolve team name
WHERE t.cost_center = 'CC-4401-Support'                 -- Support team's accounting code
  AND t.actor      = 'sarah@example.com'               -- SDK `user` attribution
  AND t.created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY 1;

-- Same question, but grouped by the human from the users directory:
SELECT
    u.display_name,
    sum(t.cost_usd) AS cost_usd,
    count(*)        AS calls
FROM transactions t
JOIN users u ON u.id = t.user_id
JOIN workspaces w ON w.id = t.workspace_id
WHERE w.cost_center = 'CC-4401-Support'
  AND u.email = 'sarah@example.com'
  AND t.created_at >= now() - interval '7 days'
GROUP BY 1;

-- -----------------------------------------------------------------------------
-- Q2. "Total cost by provider for CFO dashboard"
--     Reads the pre-aggregated materialized view (fast, even at scale).
-- -----------------------------------------------------------------------------
SELECT
    provider,
    sum(cost_usd)           AS total_cost_usd,
    sum(amortized_cost_usd) AS total_amortized_usd,
    sum(call_count)         AS total_calls
FROM mv_cost_by_provider_daily
WHERE day >= date_trunc('month', now())
GROUP BY provider
ORDER BY total_cost_usd DESC;

-- MTD trend by provider + day (for a stacked-area chart):
SELECT day, provider, cost_usd
FROM mv_cost_by_provider_daily
WHERE day >= date_trunc('month', now())
ORDER BY day, provider;

-- -----------------------------------------------------------------------------
-- Q3. Cost-center rollup with budget variance (month-to-date)
-- -----------------------------------------------------------------------------
SELECT
    w.cost_center,
    w.name                                   AS team,
    w.budget_cap_usd,
    sum(t.cost_usd)                          AS mtd_cost_usd,
    CASE
        WHEN w.budget_cap_usd IS NOT NULL
        THEN round(100.0 * sum(t.cost_usd) / w.budget_cap_usd, 2)
        ELSE NULL
    END                                      AS pct_of_budget
FROM transactions t
JOIN workspaces w ON w.id = t.workspace_id
WHERE t.created_at >= date_trunc('month', now())
GROUP BY w.id, w.cost_center, w.name, w.budget_cap_usd
ORDER BY mtd_cost_usd DESC;

-- -----------------------------------------------------------------------------
-- Q4. Virtual key budget-caps (who is about to blow their cap?)
-- -----------------------------------------------------------------------------
SELECT
    vk.name,
    vk.budget_cap_usd,
    sum(t.cost_usd) AS mtd_spend_usd,
    round(100.0 * sum(t.cost_usd) / NULLIF(vk.budget_cap_usd, 0), 2) AS pct
FROM virtual_keys vk
LEFT JOIN transactions t
       ON t.virtual_key_id = vk.id
      AND t.created_at >= date_trunc('month', now())
WHERE vk.status = 'active' AND vk.budget_cap_usd IS NOT NULL
GROUP BY vk.id, vk.name, vk.budget_cap_usd
ORDER BY pct DESC NULLS LAST;

-- -----------------------------------------------------------------------------
-- Q5. Shadow AI detection (spend outside approved channels)
-- -----------------------------------------------------------------------------
SELECT
    actor, provider, model,
    sum(cost_usd) AS usd,
    count(*)      AS calls
FROM transactions
WHERE shadow_ai_flag
  AND created_at >= now() - interval '30 days'
GROUP BY 1, 2, 3
ORDER BY usd DESC;

-- -----------------------------------------------------------------------------
-- Q6. Amortized cost explanation — cache-write cost spread across reads
--     A cache-write call incurs the write cost; subsequent cache-read calls
--     carry a tiny amortized slice instead of the full prompt cost.
-- -----------------------------------------------------------------------------
SELECT
    model,
    sum(cache_creation_tokens)                                   AS cache_write_tokens,
    sum(cache_read_tokens)                                       AS cache_read_tokens,
    sum(input_cost_usd)                                          AS raw_input_cost_usd,
    sum(amortized_cost_usd) - sum(input_cost_usd)                AS amortization_delta_usd,
    sum(cost_usd)                                                AS total_cost_usd
FROM transactions
WHERE created_at >= date_trunc('month', now())
GROUP BY model
ORDER BY total_cost_usd DESC;

-- -----------------------------------------------------------------------------
-- Q7. Reconciliation — ledger vs. vendor invoice, per provider / month
-- -----------------------------------------------------------------------------
SELECT
    provider,
    month,
    ledger_cost_usd,
    invoice_amount_usd,
    variance_usd,
    status
FROM mv_provider_reconciliation
WHERE month >= date_trunc('month', now()) - interval '2 months'
ORDER BY month DESC, provider;

-- Detailed drill-in for a specific provider/month:
SELECT
    t.request_id,
    t.model,
    t.cost_usd,
    t.created_at
FROM transactions t
LEFT JOIN provider_invoices i
       ON i.organization_id = t.organization_id
      AND i.provider        = t.provider
      AND t.created_at::date BETWEEN i.period_start AND i.period_end
WHERE t.provider = 'openai'
  AND date_trunc('month', t.created_at) = date_trunc('month', now())
  AND i.invoice_number = 'INV-OPENAI-2026-07'
ORDER BY t.cost_usd DESC
LIMIT 100;
