# Deploying Tokenistt for your team

This is the operator guide for running Tokenistt beyond your own laptop. It describes what the Docker Compose
stack does today, including its limits. Nothing here is a managed service: you run it, you back it up.

## 1. First run

```bash
node scripts/setup.mjs            # writes .env with fresh secrets; never overwrites an existing .env
docker compose up --build -d
```

Open http://localhost:3001. The first visit shows **Set up Tokenistt**: enter an organization name, your email, a
password, and the setup token, which is `ADMIN_SECRET` from your `.env`. That creates the owner account and closes the
setup form; further users must be added by an owner.

Defaults are deliberately conservative:

| Setting | Default | Meaning |
|---|---|---|
| `BIND_ADDR` | `127.0.0.1` | Gateway (3000) and dashboard (3001) listen on this machine only |
| `AUTH_MODE` | `jwt` | Sign-in required. `open` means no login: throwaway local installs only |
| Postgres, Redis | not published | Reachable only on the Compose network. Redis requires `REDIS_PASSWORD` |
| `METRICS_TOKEN` | required | `/metrics` needs `Authorization: Bearer <token>` |

To reach the database from the host: `docker compose exec postgres psql -U tokenistt tokenistt`.

## 2. Serving other machines (TLS)

Tokenistt does not terminate TLS itself. The Compose file includes an optional Caddy profile:

```bash
# .env
DOMAIN=tokenistt.example.com                       # must resolve to this host; ports 80/443 open
PUBLIC_GATEWAY_URL=https://tokenistt.example.com
CORS_ORIGINS=https://tokenistt.example.com
TRUST_PROXY=1                                      # one proxy in front of the gateway

docker compose --profile tls up -d
```

Caddy obtains a certificate automatically. It forwards only the developer-facing gateway paths
(`/v1/chat/completions`, `/v1/models`, `/v1/ingest/*`, `/v1/sync`, `/v1/logs`, `/v1/usage/*`, `/health`, `/ready`)
to the gateway and everything else to the dashboard. `/metrics` and `/v1/admin/*` are not exposed on the public
address. Developers use `https://<DOMAIN>/v1` as their base URL.

`DOMAIN=localhost` gives a locally trusted certificate, handy for trying the profile.

Using your own proxy (nginx, ALB, Traefik) instead: keep `BIND_ADDR=127.0.0.1`, proxy to ports 3000/3001, set
`TRUST_PROXY` to the number of proxies so rate limits see real client IPs, and apply the same path restrictions. If you
must serve the dashboard over plain HTTP on a trusted network, set `COOKIE_SECURE=false`, otherwise browsers drop the
session cookie and login appears to do nothing.

## 3. Health and monitoring

- `GET /health` (gateway): 200, or **503 when the database is unreachable**. This is the container healthcheck.
- `GET /ready` (gateway): also requires Redis when `REDIS_REQUIRED=true` (the Compose default).
- `GET /api/health` (dashboard): 200, or 503 when the database is unreachable.
- `GET /metrics` (gateway, bearer `METRICS_TOKEN`): Prometheus text format. Today it counts successful requests and
  spend by provider and model; there are no error-rate or latency histograms yet. This repo does not ship a Prometheus
  or Grafana stack for it.

The gateway fails open: if Postgres is down, requests still proxy and events queue to a file on the
`gateway_tx_queue` volume, replaying when the database returns. If Redis is down, rate limiting and budget
reservation fall back to the database and the client reconnects on its own. Keep that volume: events queued while the
database is down are only on it.

## 4. Backups

Postgres is the system of record. Back up three things:

1. **The database**
   ```bash
   docker compose exec -T postgres pg_dump -U tokenistt -Fc tokenistt > tokenistt-$(date +%F).dump
   ```
2. **Your `.env`**, above all `MASTER_KEY`. It encrypts provider keys and connector credentials. A database backup
   without the matching `MASTER_KEY` cannot decrypt them, and there is **no key-rotation tool yet**.
3. The `gateway_tx_queue` volume if you care about events queued during an outage.

Restore into an empty database:

```bash
docker compose exec -T postgres psql -U tokenistt -d postgres -c "CREATE DATABASE tokenistt_restored"
docker compose exec -T postgres pg_restore -U tokenistt -d tokenistt_restored --no-owner < tokenistt-2026-11-12.dump
```

Check it (for example `select count(*) from users`) before pointing a stack at it. Test your restore before you need it.

## 5. Upgrading

```bash
docker compose exec -T postgres pg_dump -U tokenistt -Fc tokenistt > pre-upgrade.dump   # always first
git pull
node scripts/setup.mjs            # adds any new required secrets to your .env, changes nothing else
docker compose up --build -d      # the migrate container runs first and applies new SQL
```

Migrations run under an advisory lock, one transaction per file, and are recorded in `schema_migrations`. There are
no down-migrations: to roll back, restore the pre-upgrade dump and the previous version. Read the release notes
before upgrading across several versions.

## 6. Data retention

By default **nothing is ever deleted**: `transactions` is the immutable record of spend. The gateway creates monthly
partitions ahead of time. To cap growth, opt in:

```bash
TRANSACTIONS_RETENTION_MONTHS=24
```

Once a day the gateway then drops monthly partitions that ended more than 24 months ago. This is irreversible, and
reports for those months will no longer be reproducible from raw requests, so export first if you need them. Hourly
rollups (`hourly_spend`) are not pruned.

## 7. Limits you should know about

- One Postgres instance, no replication or multi-region story. Plan on backups, not failover.
- One gateway container is the tested topology. Running several replicas is not supported yet: the connector scheduler
  and maintenance jobs would run on each, and the on-disk event queue is per replica.
- No SSO (OIDC/SAML) and no Postgres row-level security. Access is the dashboard's email and password plus virtual keys.
- Containers run as root and are not resource-limited by default. Add limits and a log driver that fits your platform.
- See "Known gaps" in the [README](../README.md) for the full list.
