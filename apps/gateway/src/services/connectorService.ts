/**
 * services/connectorService.ts — persistence, sync orchestration and scheduling for connectors.
 * Config is stored encrypted (vault.ts, per-org key); secrets are never returned by any API.
 */
import { getPool } from '../db/pool.js';
import { decryptApiKey, encryptApiKey } from './vault.js';
import { getConnector, ConnectorError, type Entity, type WebhookRequest } from '../connectors/registry.js';

export interface ConnectorRow {
  id: string;
  type: string;
  name: string;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
}

const COLS = 'public_id::text AS id, type, name, status, last_sync_at, last_error, created_at';

function loadConfig(encrypted: string, orgId: string): Record<string, any> {
  return JSON.parse(decryptApiKey(encrypted, orgId));
}

export async function createConnector(
  orgId: string, type: string, name: string, config: Record<string, any>, verify = true
): Promise<ConnectorRow> {
  const connector = getConnector(type);
  if (!connector) throw new ConnectorError(`Unknown connector type '${type}'.`);
  const missing = connector.configFields.filter(f => f.required && !config[f.key]).map(f => f.key);
  if (missing.length) throw new ConnectorError(`Missing required config: ${missing.join(', ')}`);

  // Fail early with a readable reason instead of storing credentials that never worked.
  if (verify) await connector.authenticate({ config });

  const { rows } = await getPool().query<ConnectorRow>(
    `INSERT INTO connectors (organization_id, type, name, encrypted_config) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
    [orgId, type, name, encryptApiKey(JSON.stringify(config), orgId)]
  );
  return rows[0];
}

export async function listConnectors(orgId: string): Promise<ConnectorRow[]> {
  return (await getPool().query<ConnectorRow>(`SELECT ${COLS} FROM connectors WHERE organization_id = $1 ORDER BY id`, [orgId])).rows;
}

export async function deleteConnector(orgId: string, publicId: string): Promise<boolean> {
  const r = await getPool().query('DELETE FROM connectors WHERE public_id::text = $1 AND organization_id = $2', [publicId, orgId]);
  return (r.rowCount ?? 0) > 0;
}

async function saveEntities(orgId: string, connectorId: string, entities: Entity[]): Promise<number> {
  if (entities.length === 0) return 0;
  const pool = getPool();
  // One statement per batch of 200 keeps parameter counts sane for large syncs.
  let n = 0;
  for (let i = 0; i < entities.length; i += 200) {
    const batch = entities.slice(i, i + 200);
    const values: unknown[] = [orgId, connectorId];
    const tuples = batch.map((e, j) => {
      values.push(e.dimension, e.externalId, e.name ?? null, JSON.stringify(e.data ?? {}));
      const o = 3 + j * 4;
      return `($1,$2,$${o},$${o + 1},$${o + 2},$${o + 3},now())`;
    });
    const r = await pool.query(
      `INSERT INTO connector_entities (organization_id, connector_id, dimension, external_id, name, data, synced_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT (connector_id, dimension, external_id)
       DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, synced_at = now()`,
      values
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

async function loadRow(publicId: string, orgId?: string) {
  const { rows } = await getPool().query(
    `SELECT id::text AS internal_id, organization_id::text AS org_id, type, encrypted_config
       FROM connectors WHERE public_id::text = $1 AND ($2::text IS NULL OR organization_id::text = $2)`,
    [publicId, orgId ?? null]
  );
  return rows[0] as { internal_id: string; org_id: string; type: string; encrypted_config: string } | undefined;
}

/** Run a pull sync now. Records the run and the connector's health either way. */
export async function runSync(publicId: string, orgId?: string): Promise<{ entities: number }> {
  const row = await loadRow(publicId, orgId);
  if (!row) throw new ConnectorError('Connector not found.', 404);
  const connector = getConnector(row.type);
  if (!connector?.sync) throw new ConnectorError(`'${row.type}' is webhook-driven; it has nothing to pull.`);

  const pool = getPool();
  const run = (await pool.query(
    `INSERT INTO connector_sync_runs (connector_id, status) VALUES ($1,'running') RETURNING id::text`, [row.internal_id]
  )).rows[0].id;

  try {
    const entities = await connector.sync({ config: loadConfig(row.encrypted_config, row.org_id) });
    const saved = await saveEntities(row.org_id, row.internal_id, entities);
    await pool.query(`UPDATE connector_sync_runs SET status='success', entities_synced=$2, finished_at=now() WHERE id=$1`, [run, saved]);
    await pool.query(`UPDATE connectors SET last_sync_at=now(), last_error=NULL, status='active' WHERE id=$1`, [row.internal_id]);
    return { entities: saved };
  } catch (err: any) {
    const msg = String(err.message).slice(0, 500);
    await pool.query(`UPDATE connector_sync_runs SET status='error', error=$2, finished_at=now() WHERE id=$1`, [run, msg]);
    await pool.query(`UPDATE connectors SET last_error=$2, status='error' WHERE id=$1`, [row.internal_id, msg]);
    throw err;
  }
}

export async function testConnector(publicId: string, orgId: string): Promise<void> {
  const row = await loadRow(publicId, orgId);
  if (!row) throw new ConnectorError('Connector not found.', 404);
  await getConnector(row.type)!.authenticate({ config: loadConfig(row.encrypted_config, row.org_id) });
}

/** Authenticated by the connector's own signature check, not by a user session. */
export async function ingestWebhook(publicId: string, req: WebhookRequest): Promise<{ entities: number }> {
  const row = await loadRow(publicId);
  // Same answer for "missing" and "wrong signature" would hide nothing useful, but never
  // reveal whether an id exists to unauthenticated callers.
  if (!row) throw new ConnectorError('Invalid signature.', 401);
  const connector = getConnector(row.type);
  if (!connector?.webhook) throw new ConnectorError('Invalid signature.', 401);
  const entities = await connector.webhook({ config: loadConfig(row.encrypted_config, row.org_id) }, req);
  const saved = await saveEntities(row.org_id, row.internal_id, entities);
  await getPool().query('UPDATE connectors SET last_sync_at = now(), last_error = NULL WHERE id = $1', [row.internal_id]);
  return { entities: saved };
}

// ── scheduler ────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

export async function syncAllActive(): Promise<void> {
  const { rows } = await getPool().query<{ id: string; type: string }>(
    `SELECT public_id::text AS id, type FROM connectors WHERE status <> 'disabled'`
  );
  for (const c of rows) {
    if (!getConnector(c.type)?.sync) continue;
    await runSync(c.id).catch(err => console.warn(`[Connectors] sync ${c.type}/${c.id} failed: ${err.message}`));
  }
}

export function startConnectorScheduler(): void {
  const minutes = parseInt(process.env.CONNECTOR_SYNC_INTERVAL_MIN || '60', 10);
  if (timer || !(minutes > 0)) return;
  timer = setInterval(() => { syncAllActive().catch(() => {}); }, minutes * 60_000);
  timer.unref?.();
}

export function stopConnectorScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
