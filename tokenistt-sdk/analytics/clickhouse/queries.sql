-- =============================================================================
-- tokenistt — Sample analytics queries (run in clickhouse-client or any SQL UI)
-- All read the pre-aggregated *views*, so they stay sub-second at scale.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Q1. "Sarah's spend in the Support team, last week"
--     Uses the raw event log (high-cardinality filter hits the ORDER BY).
-- -----------------------------------------------------------------------------
SELECT
    toStartOfDay(created_at) AS day,
    sum(cost_usd)           AS cost_usd,
    sum(amortized_cost_usd) AS amortized_usd,
    count(*)                AS calls,
    sum(total_tokens)       AS tokens
FROM transactions_raw
WHERE cost_center = 'CC-4401-Support'
  AND actor      = 'sarah@example.com'
  AND created_at >= now() - INTERVAL 7 DAY
GROUP BY day
ORDER BY day;

-- -----------------------------------------------------------------------------
-- Q2. "Total cost by provider" — CFO dashboard (reads the pre-aggregate)
-- -----------------------------------------------------------------------------
SELECT
    provider,
    sum(cost_usd)           AS total_cost_usd,
    sum(amortized_cost_usd) AS total_amortized_usd,
    sum(calls)              AS total_calls
FROM v_daily_spend_by_provider
WHERE day >= toStartOfMonth(now())
GROUP BY provider
ORDER BY total_cost_usd DESC;

-- Same, but trended by day for a stacked-area chart:
SELECT day, provider, cost_usd
FROM v_daily_spend_by_provider
WHERE day >= toStartOfMonth(now())
ORDER BY day, provider;

-- -----------------------------------------------------------------------------
-- Q3. Cost-center rollup (month-to-date) + budget variance
-- -----------------------------------------------------------------------------
SELECT
    cost_center,
    sum(cost_usd) AS mtd_cost_usd,
    sum(calls)    AS calls,
    uniqExactMerge(users) AS active_users
FROM v_daily_spend_by_cost_center
WHERE day >= toStartOfMonth(now())
GROUP BY cost_center
ORDER BY mtd_cost_usd DESC;

-- -----------------------------------------------------------------------------
-- Q4. Anomaly feed — users spending > 3x their 30-day daily average
--     (on-demand; the consumer also persists these into spend_anomalies)
-- -----------------------------------------------------------------------------
SELECT actor, spend_24h, avg_daily_30d, ratio
FROM v_user_anomalies
ORDER BY ratio DESC;

-- Persist currently-flagged anomalies (run on a schedule by the consumer):
-- INSERT INTO spend_anomalies
--     (organization_id, actor, window_start, window_end, spend_window, avg_daily_30d, ratio, severity)
-- SELECT organization_id, actor,
--        now() - INTERVAL 24 HOUR, now(),
--        spend_24h, avg_daily_30d, ratio,
--        multiIf(ratio > 10, 'critical', ratio > 5, 'high', 'medium')
-- FROM v_user_anomalies;

-- -----------------------------------------------------------------------------
-- Q5. Shadow-AI spot check (raw, last 30 days)
-- -----------------------------------------------------------------------------
SELECT actor, provider, model, sum(cost_usd) AS usd, count(*) AS calls
FROM transactions_raw
WHERE shadow_ai_flag = 1
  AND created_at >= now() - INTERVAL 30 DAY
GROUP BY actor, provider, model
ORDER BY usd DESC;

-- -----------------------------------------------------------------------------
-- Q6. Retention sanity — rows older than the TTL are auto-dropped by ClickHouse;
--     confirm the live window sizes:
-- -----------------------------------------------------------------------------
SELECT
    'raw'                 AS layer, toInt64(count()) AS rows, min(created_at) AS oldest, max(created_at) AS newest
FROM transactions_raw
UNION ALL
SELECT 'hourly_user', toInt64(count()), min(hour), max(hour)
FROM v_hourly_spend_by_user
UNION ALL
SELECT 'daily_cc', toInt64(count()), min(day), max(day)
FROM v_daily_spend_by_cost_center;
