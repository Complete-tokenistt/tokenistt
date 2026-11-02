/**
 * Configuration + credentials.
 *
 * Stored in one JSON file under the user's config dir, written atomically with mode 0600 (POSIX).
 * On Windows file modes do not apply: the file lives in the user profile (%APPDATA%) and relies on its ACLs.
 * There is no OS-keychain integration yet; that is a documented limitation.
 *
 * Environment variables always win over the file, so CI needs no `login` step:
 *   TOKENISTT_API_URL, TOKENISTT_TOKEN, TOKENISTT_ADMIN_SECRET, TOKENISTT_ORG_ID, TOKENISTT_API_KEY
 */
import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { CliError } from '../core/errors.js';

export const DEFAULT_API_URL = 'http://localhost:3000';

const Connection = z.object({
  connectedAt: z.string(),
  organization: z.object({ id: z.string(), name: z.string(), slug: z.string().optional() }),
});

const Profile = z.object({
  apiUrl: z.string().url(),
  token: z.string().min(1).optional(),
  adminSecret: z.string().min(1).optional(),
  organizationId: z.string().regex(/^\d+$/).optional(),
  apiKey: z.string().min(1).optional(),
  connection: Connection.optional(),
});
const ConfigFile = z.object({ version: z.literal(1), profile: Profile });

export type StoredProfile = z.infer<typeof Profile>;
export type ConnectionInfo = z.infer<typeof Connection>;

export interface ResolvedConfig {
  apiUrl: string;
  token?: string;
  adminSecret?: string;
  organizationId?: string;
  apiKey?: string;
  connection?: ConnectionInfo;
  /** Which fields came from the environment (never their values). */
  fromEnv: string[];
  /** Whether a config file exists on disk. */
  hasFile: boolean;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TOKENISTT_CONFIG_DIR) return env.TOKENISTT_CONFIG_DIR;
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'tokenistt');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'tokenistt');
}

export const configFile = (env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), 'config.json');

export function readProfile(env: NodeJS.ProcessEnv = process.env): StoredProfile | undefined {
  const file = configFile(env);
  if (!existsSync(file)) return undefined;
  try {
    return ConfigFile.parse(JSON.parse(readFileSync(file, 'utf8'))).profile;
  } catch {
    throw new CliError(`Config file ${file} is unreadable or invalid.`, 1, 'Delete it and run `tokenistt login` again.');
  }
}

export function writeProfile(profile: StoredProfile, env: NodeJS.ProcessEnv = process.env): void {
  const file = configFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, profile: Profile.parse(profile) }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function clearProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = configFile(env);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

/** True when the file is readable by group/others (POSIX only). */
export function isFileTooOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform === 'win32') return false;
  const file = configFile(env);
  return existsSync(file) && (statSync(file).mode & 0o077) !== 0;
}

const clean = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const stored = readProfile(env);
  const fromEnv: string[] = [];
  const pick = <K extends 'token' | 'adminSecret' | 'organizationId' | 'apiKey'>(key: K, envName: string): string | undefined => {
    const e = clean(env[envName]);
    if (e) {
      fromEnv.push(envName);
      return e;
    }
    return stored?.[key];
  };
  const envUrl = clean(env.TOKENISTT_API_URL);
  if (envUrl) fromEnv.push('TOKENISTT_API_URL');
  return {
    apiUrl: (envUrl ?? stored?.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, ''),
    token: pick('token', 'TOKENISTT_TOKEN'),
    adminSecret: pick('adminSecret', 'TOKENISTT_ADMIN_SECRET'),
    organizationId: pick('organizationId', 'TOKENISTT_ORG_ID'),
    apiKey: pick('apiKey', 'TOKENISTT_API_KEY'),
    connection: stored?.connection,
    fromEnv,
    hasFile: existsSync(configFile(env)),
  };
}
