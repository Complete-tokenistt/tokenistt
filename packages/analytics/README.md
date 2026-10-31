# Tokenistt Real-time Analytics Pipeline (Phase 3 — Prompt 6)

Sub-second dashboard queries over millions of AI-spend transactions, built on
**ClickHouse** (OLAP store + pre-aggregation) fed by **Kafka** and a small
**TypeScript consumer**.

```
            ┌────────────┐     transactions topic      ┌──────────────────┐
 gateway ──▶│   Kafka    │ ──────────────────────────▶│  consumer (TS)    │
 (Phase 1-2)└────────────┘   (JSON, 1 msg / API call) └────────┬─────────┘
                                                                 │ INSERT
                                                                 ▼
                                                        ┌──────────────────┐
                                                        │   ClickHouse     │
                                                        │  transactions_raw │  ← raw event log (TTL 90d)
                                                        │  + Materialized   │
                                                        │    Views (TTL 2y) │  ← hourly_spend_by_user,
                                                        │                  │     daily_spend_by_cost_center,
                                                        │                  │     daily_spend_by_provider,
                                                        │                  │     daily_spend_by_user
                                                        │  spend_anomalies │  ← >3x 30-day avg (TTL 2y)
                                                        └──────────────────┘
                                                                 │
                                                            dashboards / alerts
```

## Run it

```bash
cd analytics
docker compose up --build
# in another shell, generate synthetic load (creates 30d history + a spiking user):
docker compose exec consumer npm run producer
```

- ClickHouse HTTP: http://localhost:8123  ·  Kafka: localhost:9092
- Grafana: http://localhost:3000 (admin/admin)
- Table init SQL auto-runs from `clickhouse/init/01_schema.sql` on first start.

Query it:

```bash
docker compose exec clickhouse clickhouse-client
# then paste queries from clickhouse/queries.sql
```

## How the requirements are met

### Ingest from Kafka/Redis streams
The consumer (`consumer/src`) connects to Kafka (`kafkajs`), subscribes to the
`transactions` topic, and buffers messages into bounded batches that are
bulk-inserted into ClickHouse (`transactions_raw`) every `FLUSH_MS` / `BATCH_SIZE`.
The event shape mirrors the Phase 3 Postgres `transactions` row, so the gateway
can emit to both. (Redis Streams can be swapped in by replacing `src/kafka.ts` —
the ingest/ClickHouse path is unchanged.)

### Pre-aggregation
ClickHouse **Materialized Views** do the rollups incrementally at insert time:
`hourly_spend_by_user`, `daily_spend_by_user`, `daily_spend_by_cost_center`,
`daily_spend_by_provider`. Dashboards read the `*_merge` views
(`v_hourly_spend_by_user`, etc.), so a query over millions of raw rows collapses
into a tiny pre-aggregated scan → **sub-second**.

### Anomaly detection (>3× 30-day average)
`v_user_anomalies` joins a 24-hour window (`v_hourly_spend_by_user`) against a
trailing-30-day daily average (`v_daily_spend_by_user`) and flags any user whose
recent spend `> 3 * avg_daily_30d`. The consumer persists flagged rows into
`spend_anomalies` every `ANOMALY_INTERVAL_MS` (default 5 min), ready for alerts.
Run the synthetic producer and after a minute query:

```sql
SELECT actor, spend_24h, avg_daily_30d, ratio, severity
FROM spend_anomalies ORDER BY ratio DESC;   -- spike@example.com should appear
```

### Retention policy
Enforced by ClickHouse **TTL** (auto-drops expired parts, no manual jobs):
- `transactions_raw` → **90 days**
- aggregate views (`*_spend_*`) and `spend_anomalies` → **2 years**

## File map

| Path | What |
| --- | --- |
| `docker-compose.yml` | ClickHouse + Kafka (KRaFT) + consumer + Grafana |
| `clickhouse/init/01_schema.sql` | Raw table, 4 pre-aggregate MVs, `spend_anomalies`, `v_user_anomalies`, TTLs |
| `clickhouse/queries.sql` | Sample dashboard + anomaly queries |
| `consumer/src/config.ts` | Env-driven configuration |
| `consumer/src/clickhouse.ts` | ClickHouse client, row mapping, `insertTransactions`, `persistAnomalies` |
| `consumer/src/kafka.ts` | Kafka consumer → ingest buffer |
| `consumer/src/ingest.ts` | Bounded batch buffer with timed flush + retry/requeue |
| `consumer/src/anomalies.ts` | Scheduled anomaly persistence |
| `consumer/src/index.ts` | Wiring + graceful shutdown |
| `consumer/scripts/producer.ts` | Synthetic load generator (sets up 30d history + a spiking user) |
| `consumer/Dockerfile` | Image for the consumer service |
| `grafana/provisioning/datasources/datasource.yml` | ClickHouse datasource (`uid: tokenistt`) |
| `grafana/provisioning/dashboards/dashboard.yml` | File provider → `/var/lib/grafana/dashboards` |
| `grafana/dashboards/tokenistt-spend.json` | Spend-by-provider, by-cost-center, daily trend, anomalies |

## Tuning notes
- **Ordering for drill-downs:** `transactions_raw` is `ORDER BY (organization_id, cost_center, actor, created_at)` — matches the "Sarah in Support last week" filter. Add `provider` to the key if you drill by provider on the raw table often.
- **Partitions:** `toYYYYMM(...)` keeps partitions ~month-sized; adjust to `toStartOfMonth`/`toMonday` for different retention/scan shapes.
- **Throughput:** raise `BATCH_SIZE`/`FLUSH_MS` for higher ingest; ClickHouse handles 100k+ rows/s inserts easily.
- **Exactly-once:** inserts are at-least-once; the raw table is an immutable log so duplicates only nudge aggregates slightly. Add a `request_id` dedup (ReplacingMergeTree) if you need exactly-once.
- **Dashboards:** point Grafana/Metabase at `v_*` views over the HTTP port (8123).

## Grafana (BI layer)

A Grafana service is included in `docker-compose.yml` (port `3000`, admin/admin)
with the ClickHouse datasource auto-provisioned and a sample spend dashboard.

```bash
docker compose up --build   # grafana starts alongside clickhouse + kafka
# open http://localhost:3000  (admin / admin)
```

The dashboard queries the `v_*` views (pre-aggregated, sub-second). To point it at
real data, run the consumer (`docker compose exec consumer npm run producer`) so
`transactions_raw` + the materialized views are populated, then refresh the
dashboard. You can also import your own JSON via Dashboard settings → JSON model.
