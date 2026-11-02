/**
 * `connect` / `connection status`: establish and monitor the link to the gateway.
 *
 * "Connected" means: the gateway answers /health and the stored credentials are accepted. Unreachable
 * is reported as `offline` (exit code 4), distinct from `unauthorized` (exit code 3), so scripts and
 * the sync queue can tell "retry later" from "fix your login".
 */
import { ApiClient } from '../api/client.js';
import { AuthError, NetworkError, CliError } from '../core/errors.js';
import { readProfile, writeProfile, type ResolvedConfig } from '../config/store.js';
import type { Health, Whoami } from './auth.js';

export interface Discovery {
  organization: Whoami['organization'];
  role: string;
  workspaces: Array<{ id: string; name: string; cost_center: string }>;
  projects: Array<{ id: string; name: string; slug: string; environment: string }>;
}

export interface ConnectResult {
  apiUrl: string;
  latencyMs: number;
  health: Health;
  discovery?: Discovery;
  note?: string;
}

const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t = Date.now();
  const v = await fn();
  return [v, Date.now() - t];
};

export async function connect(client: ApiClient, env: NodeJS.ProcessEnv = process.env): Promise<ConnectResult> {
  if (!client.hasManagementCredentials && !client.hasKey) throw new AuthError('Not logged in.');
  const [health, latencyMs] = await timed(() => client.get<Health>('none', '/health'));
  const result: ConnectResult = { apiUrl: client.baseUrl, latencyMs, health };

  if (client.hasManagementCredentials) {
    const who = await client.get<Whoami>('management', '/v1/admin/whoami');
    const [workspaces, projects] = await Promise.all([
      client.get<Discovery['workspaces']>('management', '/v1/admin/workspaces'),
      client.get<Discovery['projects']>('management', '/v1/admin/projects'),
    ]);
    result.discovery = { organization: who.organization, role: who.role, workspaces, projects };
    const stored = readProfile(env);
    if (stored) {
      writeProfile({ ...stored, connection: { connectedAt: new Date().toISOString(), organization: { id: who.organization.id, name: who.organization.name, slug: who.organization.slug } } }, env);
    } else {
      result.note = 'Credentials come from the environment, so the connection was verified but not saved.';
    }
  } else {
    await client.get('key', '/v1/usage/me');
    result.note = 'Only an API key is configured: organization discovery needs a dashboard token or admin secret.';
  }
  return result;
}

export function disconnect(env: NodeJS.ProcessEnv = process.env): { wasConnected: boolean } {
  const stored = readProfile(env);
  if (!stored?.connection) return { wasConnected: false };
  const { connection: _drop, ...rest } = stored;
  writeProfile(rest, env);
  return { wasConnected: true };
}

export type ConnectionState = 'connected' | 'offline' | 'unauthorized' | 'not_configured';

export interface ConnectionStatus {
  state: ConnectionState;
  apiUrl: string;
  latencyMs?: number;
  database?: string;
  organization?: string;
  connectedAt?: string;
  detail?: string;
}

/** Live probe. Never throws for expected failures; the state says what happened. */
export async function connectionStatus(client: ApiClient, cfg: ResolvedConfig): Promise<ConnectionStatus> {
  const base: ConnectionStatus = { state: 'not_configured', apiUrl: client.baseUrl, organization: cfg.connection?.organization.name, connectedAt: cfg.connection?.connectedAt };
  if (!client.hasManagementCredentials && !client.hasKey) return { ...base, detail: 'No credentials. Run `tokenistt login`.' };
  try {
    const [health, latencyMs] = await timed(() => client.get<Health>('none', '/health'));
    if (client.hasManagementCredentials) await client.get('management', '/v1/admin/whoami');
    else await client.get('key', '/v1/usage/me');
    return { ...base, state: 'connected', latencyMs, database: health.database };
  } catch (err) {
    if (err instanceof NetworkError) return { ...base, state: 'offline', detail: err.message };
    if (err instanceof AuthError) return { ...base, state: 'unauthorized', detail: err.message };
    if (err instanceof CliError) return { ...base, state: 'offline', detail: err.message };
    throw err;
  }
}
