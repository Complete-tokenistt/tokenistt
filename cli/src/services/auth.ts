/**
 * Authentication use-cases. No terminal I/O here: commands pass data in and render what comes back.
 *
 * The gateway has no OAuth/device flow or refresh endpoint yet, so credentials are:
 *   - a dashboard session JWT (expires; `auth status` shows when),
 *   - an operator admin secret + numeric organization id, or
 *   - a virtual key (tktt_live_…) for usage ingestion and `usage/me`.
 */
import { ApiClient } from '../api/client.js';
import { AuthError, UsageError } from '../core/errors.js';
import { mask } from '../core/redact.js';
import { clearProfile, readProfile, resolveConfig, writeProfile, type ResolvedConfig, type StoredProfile } from '../config/store.js';

export interface Whoami {
  actor: string;
  role: string;
  operator: boolean;
  organization: { id: string; name: string; slug: string };
}

export interface Health {
  status: string;
  database?: string;
  providers?: string[];
}

export interface KeyUsage {
  key: { name: string; prefix: string };
  month: { requests: number; cost_usd: number };
}

export interface LoginInput {
  apiUrl: string;
  token?: string;
  adminSecret?: string;
  organizationId?: string;
  apiKey?: string;
}

export interface LoginResult {
  apiUrl: string;
  credentials: Array<'dashboard token' | 'admin secret' | 'api key'>;
  identity?: Whoami;
  key?: { name: string; prefix: string };
  health: Health;
}

export interface TokenInfo {
  expiresAt?: string;
  expired?: boolean;
  role?: string;
  email?: string;
}

/** Decode (not verify) a dashboard JWT so we can tell the user when it expires. */
export function describeToken(jwt: string, now = Date.now()): TokenInfo {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number; role?: string; email?: string };
    const out: TokenInfo = { role: payload.role, email: payload.email };
    if (typeof payload.exp === 'number') {
      out.expiresAt = new Date(payload.exp * 1000).toISOString();
      out.expired = payload.exp * 1000 <= now;
    }
    return out;
  } catch {
    return {};
  }
}

export function validateLoginInput(i: LoginInput): void {
  if (!/^https?:\/\//.test(i.apiUrl)) throw new UsageError(`API URL "${i.apiUrl}" must start with http:// or https://.`);
  if (!i.token && !i.adminSecret && !i.apiKey) throw new UsageError('No credential supplied.', 'Provide a dashboard token, an admin secret, or a virtual API key.');
  if (i.adminSecret && !i.organizationId) throw new UsageError('An admin secret needs an organization id.', 'Pass --org-id <numeric id> (the operator secret can act on any organization).');
  if (i.organizationId && !/^\d+$/.test(i.organizationId)) throw new UsageError('The organization id must be numeric.');
  if (i.apiKey && !i.apiKey.startsWith('tktt_live_')) throw new UsageError('API keys start with "tktt_live_".', 'Create one with POST /v1/admin/keys or from the dashboard (API keys page).');
}

/**
 * Verify every supplied credential against the gateway, then persist. Nothing is written when
 * any check fails, so a typo can never clobber a working login.
 */
export async function login(input: LoginInput, makeClient: (cfg: ResolvedConfig) => ApiClient, env: NodeJS.ProcessEnv = process.env): Promise<LoginResult> {
  validateLoginInput(input);
  const probe = makeClient({ ...input, fromEnv: [], hasFile: false });
  const health = await probe.get<Health>('none', '/health');

  const result: LoginResult = { apiUrl: input.apiUrl, credentials: [], health };
  if (input.token || input.adminSecret) {
    result.identity = await probe.get<Whoami>('management', '/v1/admin/whoami');
    result.credentials.push(input.token ? 'dashboard token' : 'admin secret');
  }
  if (input.apiKey) {
    const usage = await probe.get<KeyUsage>('key', '/v1/usage/me');
    result.key = usage.key;
    result.credentials.push('api key');
  }

  const previous = readProfile(env);
  const profile: StoredProfile = {
    apiUrl: input.apiUrl.replace(/\/+$/, ''),
    // supplied credentials replace stored ones of the same kind; others are kept
    token: input.token ?? (input.adminSecret ? undefined : previous?.token),
    adminSecret: input.adminSecret ?? (input.token ? undefined : previous?.adminSecret),
    organizationId: input.organizationId ?? previous?.organizationId,
    apiKey: input.apiKey ?? previous?.apiKey,
    connection: previous?.apiUrl === input.apiUrl.replace(/\/+$/, '') ? previous?.connection : undefined,
  };
  writeProfile(profile, env);
  return result;
}

export interface AuthStatus {
  authenticated: boolean;
  apiUrl: string;
  source: 'environment' | 'config file' | 'none';
  credentials: Array<{ kind: string; preview: string; from: 'env' | 'file'; expiresAt?: string; expired?: boolean }>;
  organizationId?: string;
}

/** Local view of which credentials are in effect. Makes no network call. */
export function authStatus(cfg: ResolvedConfig): AuthStatus {
  const from = (envName: string): 'env' | 'file' => (cfg.fromEnv.includes(envName) ? 'env' : 'file');
  const credentials: AuthStatus['credentials'] = [];
  if (cfg.token) {
    const info = describeToken(cfg.token);
    credentials.push({ kind: 'dashboard token', preview: mask(cfg.token), from: from('TOKENISTT_TOKEN'), expiresAt: info.expiresAt, expired: info.expired });
  }
  if (cfg.adminSecret) credentials.push({ kind: 'admin secret', preview: mask(cfg.adminSecret), from: from('TOKENISTT_ADMIN_SECRET') });
  if (cfg.apiKey) credentials.push({ kind: 'api key', preview: mask(cfg.apiKey), from: from('TOKENISTT_API_KEY') });
  return {
    authenticated: credentials.length > 0,
    apiUrl: cfg.apiUrl,
    source: credentials.length === 0 ? 'none' : credentials.some((c) => c.from === 'env') ? (cfg.hasFile ? 'config file' : 'environment') : 'config file',
    credentials,
    organizationId: cfg.organizationId,
  };
}

/** Ask the gateway who the stored management credentials belong to. */
export async function whoami(client: ApiClient): Promise<Whoami> {
  if (!client.hasManagementCredentials) {
    throw new AuthError('`whoami` needs a dashboard token or an operator admin secret; only an API key is configured.');
  }
  return client.get<Whoami>('management', '/v1/admin/whoami');
}

export function logout(env: NodeJS.ProcessEnv = process.env): { removed: boolean } {
  return { removed: clearProfile(env) };
}

export { resolveConfig };
