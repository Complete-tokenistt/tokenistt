/**
 * `tokenistt doctor`: each check says what it found and, when it is not fine, exactly what to do.
 * Later phases register further checks (project config, SDK integration, local queue, policies).
 */
import { existsSync } from 'node:fs';
import { ApiClient } from '../api/client.js';
import { ApiError, CliError } from '../core/errors.js';
import { configFile, DEFAULT_API_URL, isFileTooOpen, type ResolvedConfig } from '../config/store.js';
import { repoInfo } from '../project/git.js';
import { databasePath, openDatabase, SCHEMA_VERSION } from '../store/db.js';
import { readProjectConfig } from '../store/project.js';
import { describeToken, type Health, type KeyUsage, type Whoami } from './auth.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorContext {
  cfg: ResolvedConfig;
  client: ApiClient;
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

const MIN_NODE: [number, number] = [22, 13];

/** No gateway was ever set up: no credentials, no saved profile, and no URL given. Local features work without one. */
export function isLocalOnly(cfg: ResolvedConfig): boolean {
  const noCredentials = !cfg.token && !cfg.adminSecret && !cfg.apiKey;
  return noCredentials && !cfg.hasFile && !cfg.fromEnv.includes('TOKENISTT_API_URL') && cfg.apiUrl === DEFAULT_API_URL;
}

const LOCAL_ONLY = 'Local-only mode (no gateway configured)';

type Check = (ctx: DoctorContext) => Promise<CheckResult> | CheckResult;

const nodeVersion: Check = ({ nodeVersion: v }) => {
  const [major = 0, minor = 0] = v.replace(/^v/, '').split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  const min = MIN_NODE.join('.');
  return ok
    ? { id: 'node', title: 'Node.js version', status: 'ok', detail: v }
    : { id: 'node', title: 'Node.js version', status: 'fail', detail: `${v} is older than ${min}`, fix: `Install Node.js ${min} or newer.` };
};

const project: Check = ({ cwd }) => {
  const title = 'Project';
  const repo = repoInfo(cwd ?? process.cwd());
  if (!repo) return { id: 'project', title, status: 'skip', detail: 'Not inside a Git repository' };
  try {
    const config = readProjectConfig(repo.root);
    if (!config) return { id: 'project', title, status: 'skip', detail: `${repo.name} is not set up`, fix: 'Run `tokenistt init` for local features.' };
    return { id: 'project', title, status: 'ok', detail: `${config.name} (${config.projectId})` };
  } catch (err) {
    return { id: 'project', title, status: 'fail', detail: err instanceof CliError ? err.message : String(err), fix: err instanceof CliError ? err.hint : undefined };
  }
};

const localDatabase: Check = ({ cwd }) => {
  const title = 'Local database';
  const repo = repoInfo(cwd ?? process.cwd());
  if (!repo || !existsSync(databasePath(repo.root))) return { id: 'local-db', title, status: 'skip', detail: 'Not created yet' };
  try {
    openDatabase(repo.root).close();
    return { id: 'local-db', title, status: 'ok', detail: `schema ${SCHEMA_VERSION}` };
  } catch (err) {
    return { id: 'local-db', title, status: 'fail', detail: err instanceof CliError ? err.message : String(err), fix: err instanceof CliError ? err.hint : undefined };
  }
};

const configPermissions: Check = ({ env, cfg }) => {
  if (!cfg.hasFile) return { id: 'config-file', title: 'Config file', status: 'skip', detail: 'No config file; relying on environment variables or not logged in.' };
  if (isFileTooOpen(env)) {
    return { id: 'config-file', title: 'Config file', status: 'warn', detail: `${configFile(env)} is readable by other users`, fix: `chmod 600 ${configFile(env)}` };
  }
  return { id: 'config-file', title: 'Config file', status: 'ok', detail: configFile(env) };
};

const credentials: Check = ({ cfg }) => {
  if (isLocalOnly(cfg)) {
    return { id: 'credentials', title: 'Credentials', status: 'skip', detail: LOCAL_ONLY, fix: 'Optional: `tokenistt login` links a gateway for org-wide cost, budgets and policies.' };
  }
  const kinds = [cfg.token && 'dashboard token', cfg.adminSecret && 'admin secret', cfg.apiKey && 'api key'].filter(Boolean);
  if (kinds.length === 0) {
    return { id: 'credentials', title: 'Credentials', status: 'fail', detail: 'None configured', fix: 'Run `tokenistt login` (or set TOKENISTT_TOKEN / TOKENISTT_API_KEY for CI).' };
  }
  if (cfg.token) {
    const info = describeToken(cfg.token);
    if (info.expired) return { id: 'credentials', title: 'Credentials', status: 'fail', detail: `Dashboard token expired ${info.expiresAt}`, fix: 'Run `tokenistt login` with a fresh token.' };
  }
  return { id: 'credentials', title: 'Credentials', status: 'ok', detail: kinds.join(', ') };
};

const gatewayHealth: Check = async ({ client, cfg }) => {
  if (isLocalOnly(cfg)) return { id: 'gateway', title: 'Gateway', status: 'skip', detail: LOCAL_ONLY };
  try {
    const h = await client.get<Health>('none', '/health');
    if (h.database && /unreachable/.test(h.database)) {
      return { id: 'gateway', title: 'Gateway', status: 'warn', detail: `${client.baseUrl} is up but its database is unreachable`, fix: 'Check DATABASE_URL and that Postgres is running (`docker compose ps`).' };
    }
    return { id: 'gateway', title: 'Gateway', status: 'ok', detail: `${client.baseUrl} (database: ${h.database ?? 'n/a'}, providers: ${(h.providers ?? []).join(', ') || 'none'})` };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return { id: 'gateway', title: 'Gateway', status: 'fail', detail: `${client.baseUrl} answered, but it has no /health endpoint, so it is not a Tokenistt gateway`, fix: 'Point TOKENISTT_API_URL (or `tokenistt auth configure --api-url`) at the gateway, not the dashboard or another service.' };
    }
    return { id: 'gateway', title: 'Gateway', status: 'fail', detail: err instanceof CliError ? err.message : String(err), fix: err instanceof CliError ? err.hint : undefined };
  }
};

const managementAuth: Check = async ({ client }) => {
  if (!client.hasManagementCredentials) {
    return { id: 'management-auth', title: 'Management API access', status: 'skip', detail: 'No dashboard token / admin secret configured', fix: 'Needed for usage, cost, policy and provider commands: `tokenistt login`.' };
  }
  try {
    const w = await client.get<Whoami>('management', '/v1/admin/whoami');
    return { id: 'management-auth', title: 'Management API access', status: 'ok', detail: `${w.actor} (${w.role}) in ${w.organization.name}` };
  } catch (err) {
    return { id: 'management-auth', title: 'Management API access', status: 'fail', detail: err instanceof CliError ? err.message : String(err), fix: err instanceof CliError ? err.hint : undefined };
  }
};

const ingestKey: Check = async ({ client }) => {
  if (!client.hasKey) {
    return { id: 'api-key', title: 'API key (usage ingestion)', status: 'skip', detail: 'No virtual key configured', fix: 'Needed to send telemetry: create a key in the dashboard and run `tokenistt login`.' };
  }
  try {
    const u = await client.get<KeyUsage>('key', '/v1/usage/me');
    return { id: 'api-key', title: 'API key (usage ingestion)', status: 'ok', detail: `${u.key.name} (${u.key.prefix})` };
  } catch (err) {
    return { id: 'api-key', title: 'API key (usage ingestion)', status: 'fail', detail: err instanceof CliError ? err.message : String(err), fix: err instanceof CliError ? err.hint : undefined };
  }
};

export const CHECKS: Check[] = [nodeVersion, project, localDatabase, configPermissions, credentials, gatewayHealth, managementAuth, ingestKey];

export interface DoctorReport {
  ok: boolean;
  summary: Record<CheckStatus, number>;
  checks: CheckResult[];
}

export async function runDoctor(ctx: DoctorContext, checks: Check[] = CHECKS): Promise<DoctorReport> {
  const results: CheckResult[] = [];
  for (const check of checks) results.push(await check(ctx));
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 } satisfies Record<CheckStatus, number>;
  for (const r of results) summary[r.status]++;
  return { ok: summary.fail === 0, summary, checks: results };
}
