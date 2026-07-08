-- =============================================================================
-- tokenistt — ClickHouse schema for real-time AI spend analytics
-- Auto-run by the ClickHouse container on first start (initdb.d).
--
-- Strategy: the consumer inserts ONE row per API call into `transactions_raw`
-- (immutable event log). ClickHouse MATERIALIZED VIEWS pre-aggregate into the
-- rollup tables the dashboards actually query, so "millions of rows" collapse
-- into sub-second scans. TTL enforces retention: raw 90d, aggregates 2y.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Raw event log (immutable, high-cardinality, full detail)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions_raw (
    event_date            Date              DEFAULT toDate(created_at),
    created_at            DateTime64(6)     DEFAULT now64(6),
    organization_id       UInt64,
    workspace_id          UInt64,
    virtual_key_id        UInt64,
    user_id               UInt64,
    actor                 String,            -- SDK `user` attribution (e.g. sarah@x.com)
    provider              String,
    model                 String,
    endpoint              String,
    request_id            String,
    cost_center           String,            -- accounting code, e.g. "CC-4401-Support"
    project_tag           String,            -- optional granular tag
    currency              String             DEFAULT 'USD',

    cost_usd              Decimal64(6),
    amortized_cost_usd    Decimal64(6),
    input_cost_usd        Decimal64(6),
    output_cost_usd       Decimal64(6),

    prompt_tokens         UInt32,
    completion_tokens      UInt32,
    total_tokens           UInt32,
    cache_creation_tokens  UInt32,
    cache_read_tokens      UInt32,

    status                 String,
    error_code             String,
    shadow_ai_flag         UInt8              DEFAULT 0,
    duration_ms            UInt32,
    metadata               String             DEFAULT '{}'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (organization_id, cost_center, actor, created_at)
TTL event_date + INTERVAL 90 DAY;          -- RAW RETENTION: 90 days

-- -----------------------------------------------------------------------------
-- 2. Pre-aggregates (the tables dashboards read)
--    Each is a MATERIALIZED VIEW whose storage engine is AggregatingMergeTree,
--    so inserts are summed/merged incrementally. Reads go through the `v_*` view
--    that collapses the AggregateFunction states with *Merge.
-- -----------------------------------------------------------------------------

-- hourly_spend_by_user
CREATE MATERIALIZED VIEW hourly_spend_by_user
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (organization_id, actor, hour)
TTL hour + INTERVAL 2 YEAR
AS SELECT
    organization_id,
    actor,
    toStartOfHour(created_at)                                               AS hour,
    countState()                                                            AS calls,
    sumState(cost_usd)                                                      AS cost_usd,
    sumState(amortized_cost_usd)                                            AS amortized_cost_usd,
    sumState(CAST(total_tokens AS UInt64))                                 AS total_tokens
FROM transactions_raw
GROUP BY organization_id, actor, hour;

CREATE VIEW v_hourly_spend_by_user AS
SELECT organization_id, actor, hour,
       countMerge(calls)              AS calls,
       sumMerge(cost_usd)             AS cost_usd,
       sumMerge(amortized_cost_usd)   AS amortized_cost_usd,
       sumMerge(total_tokens)         AS total_tokens
FROM hourly_spend_by_user;

-- daily_spend_by_user  (used by 30-day anomaly baseline)
CREATE MATERIALIZED VIEW daily_spend_by_user
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (organization_id, actor, day)
TTL day + INTERVAL 2 YEAR
AS SELECT
    organization_id,
    actor,
    toDate(created_at)                                                      AS day,
    countState()                                                            AS calls,
    sumState(cost_usd)                                                      AS cost_usd,
    sumState(amortized_cost_usd)                                            AS amortized_cost_usd,
    sumState(CAST(total_tokens AS UInt64))                                 AS total_tokens
FROM transactions_raw
GROUP BY organization_id, actor, day;

CREATE VIEW v_daily_spend_by_user AS
SELECT organization_id, actor, day,
       countMerge(calls)              AS calls,
       sumMerge(cost_usd)             AS cost_usd,
       sumMerge(amortized_cost_usd)   AS amortized_cost_usd,
       sumMerge(total_tokens)         AS total_tokens
FROM daily_spend_by_user;

-- daily_spend_by_cost_center  (required rollup)
CREATE MATERIALIZED VIEW daily_spend_by_cost_center
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (organization_id, cost_center, day)
TTL day + INTERVAL 2 YEAR
AS SELECT
    organization_id,
    cost_center,
    toDate(created_at)                                                      AS day,
    countState()                                                            AS calls,
    sumState(cost_usd)                                                      AS cost_usd,
    sumState(amortized_cost_usd)                                            AS amortized_cost_usd,
    sumState(CAST(total_tokens AS UInt64))                                 AS total_tokens,
    uniqExactState(actor)                                                   AS users,
    uniqExactState(provider)                                                AS providers
FROM transactions_raw
GROUP BY organization_id, cost_center, day;

CREATE VIEW v_daily_spend_by_cost_center AS
SELECT organization_id, cost_center, day,
       countMerge(calls)              AS calls,
       sumMerge(cost_usd)             AS cost_usd,
       sumMerge(amortized_cost_usd)   AS amortized_cost_usd,
       sumMerge(total_tokens)         AS total_tokens,
       uniqExactMerge(users)          AS users,
       uniqExactMerge(providers)      AS providers
FROM daily_spend_by_cost_center;

-- daily_spend_by_provider  (CFO "cost by provider")
CREATE MATERIALIZED VIEW daily_spend_by_provider
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (organization_id, provider, day)
TTL day + INTERVAL 2 YEAR
AS SELECT
    organization_id,
    provider,
    toDate(created_at)                                                      AS day,
    countState()                                                            AS calls,
    sumState(cost_usd)                                                      AS cost_usd,
    sumState(amortized_cost_usd)                                            AS amortized_cost_usd,
    sumState(CAST(total_tokens AS UInt64))                                 AS total_tokens,
    uniqExactState(cost_center)                                            AS cost_centers
FROM transactions_raw
GROUP BY organization_id, provider, day;

CREATE VIEW v_daily_spend_by_provider AS
SELECT organization_id, provider, day,
       countMerge(calls)              AS calls,
       sumMerge(cost_usd)             AS cost_usd,
       sumMerge(amortized_cost_usd)   AS amortized_cost_usd,
       sumMerge(total_tokens)         AS total_tokens,
       uniqExactMerge(cost_centers)   AS cost_centers
FROM daily_spend_by_provider;

-- -----------------------------------------------------------------------------
-- 3. Anomaly detection  →  users whose last-24h spend > 3x their 30-day avg
--    Exposed on-demand via `v_user_anomalies`; the consumer persists flagged
--    rows into `spend_anomalies` on a schedule.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spend_anomalies (
    detected_at     DateTime64(6) DEFAULT now64(6),
    organization_id UInt64,
    actor           String,
    window_start    DateTime64(0),
    window_end      DateTime64(0),
    spend_window    Decimal64(6),
    avg_daily_30d   Decimal64(6),
    ratio           Float64,
    severity        LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(toDate(detected_at))
ORDER BY (organization_id, actor, detected_at)
TTL toDate(detected_at) + INTERVAL 2 YEAR;   -- AGGREGATE RETENTION: 2 years

CREATE VIEW v_user_anomalies AS
WITH recent AS (
    SELECT organization_id, actor, sum(cost_usd) AS spend_24h
    FROM v_hourly_spend_by_user
    WHERE hour >= now() - INTERVAL 24 HOUR
    GROUP BY organization_id, actor
),
baseline AS (
    SELECT organization_id, actor, avg(cost_usd) AS avg_daily_30d
    FROM v_daily_spend_by_user
    WHERE day >= now() - INTERVAL 30 DAY
    GROUP BY organization_id, actor
)
SELECT
    r.organization_id,
    r.actor,
    r.spend_24h,
    b.avg_daily_30d,
    r.spend_24h / b.avg_daily_30d AS ratio
FROM recent r
JOIN baseline b USING (organization_id, actor)
WHERE b.avg_daily_30d > 0
  AND r.spend_24h > 3 * b.avg_daily_30d;          -- FLAG: > 3x 30-day average
