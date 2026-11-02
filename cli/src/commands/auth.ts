import type { Command } from 'commander';
import { UsageError, ExitCode } from '../core/errors.js';
import { ask, askSecret, isInteractive, readStdin } from '../core/prompt.js';
import { DEFAULT_API_URL, readProfile, writeProfile } from '../config/store.js';
import { authStatus, login, logout, whoami, type LoginInput } from '../services/auth.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

interface LoginFlags {
  tokenStdin?: boolean;
  adminSecretStdin?: boolean;
  apiKeyStdin?: boolean;
  orgId?: string;
}

/** Secrets are never accepted as argv (shell history, `ps`): stdin, environment, or a hidden prompt only. */
async function collectLogin(ctx: Context, flags: LoginFlags): Promise<LoginInput> {
  const env = ctx.env;
  const stdinFlags = [flags.tokenStdin, flags.adminSecretStdin, flags.apiKeyStdin].filter(Boolean).length;
  if (stdinFlags > 1) throw new UsageError('Use only one of --token-stdin, --admin-secret-stdin, --api-key-stdin.');

  const input: LoginInput = {
    apiUrl: ctx.config.apiUrl,
    organizationId: flags.orgId ?? env.TOKENISTT_ORG_ID,
    token: env.TOKENISTT_TOKEN,
    adminSecret: env.TOKENISTT_ADMIN_SECRET,
    apiKey: env.TOKENISTT_API_KEY,
  };
  if (flags.tokenStdin) input.token = await readStdin();
  else if (flags.adminSecretStdin) input.adminSecret = await readStdin();
  else if (flags.apiKeyStdin) input.apiKey = await readStdin();

  const supplied = input.token || input.adminSecret || input.apiKey;
  if (!supplied) {
    if (!isInteractive()) {
      throw new UsageError('No credentials supplied and this session is not interactive.', 'Use --token-stdin / --admin-secret-stdin / --api-key-stdin, or set TOKENISTT_TOKEN / TOKENISTT_ADMIN_SECRET / TOKENISTT_API_KEY.');
    }
    if (!ctx.env.TOKENISTT_API_URL && !ctx.config.hasFile) input.apiUrl = (await ask('Gateway URL', DEFAULT_API_URL)).replace(/\/+$/, '');
    const kind = await ask('Credential: [1] dashboard token  [2] operator admin secret  [3] virtual API key', '1');
    if (kind === '2') {
      input.adminSecret = await askSecret('Admin secret');
      input.organizationId = input.organizationId ?? (await ask('Organization id (numeric)'));
    } else if (kind === '3') input.apiKey = await askSecret('API key (tktt_live_…)');
    else input.token = await askSecret('Dashboard token');
  }
  return input;
}

export function registerAuth(program: Command, getCtx: GetCtx): void {
  program
    .command('login')
    .description('Authenticate against a Tokenistt gateway and store the credentials')
    .option('--token-stdin', 'read a dashboard session token from stdin')
    .option('--admin-secret-stdin', 'read the operator admin secret from stdin (needs --org-id)')
    .option('--api-key-stdin', 'read a virtual API key (tktt_live_…) from stdin')
    .option('--org-id <id>', 'numeric organization id (required with an admin secret)')
    .addHelpText('after', '\nThe gateway URL comes from --api-url, TOKENISTT_API_URL, or a prompt (default http://localhost:3000).\nSecrets are never taken as command-line arguments.')
    .action(async (flags: LoginFlags, cmd: Command) => {
      const ctx = getCtx(cmd);
      const input = await collectLogin(ctx, flags);
      const r = await login(input, (cfg) => ctx.makeClient(cfg), ctx.env);
      ctx.out.result(
        { ok: true, api_url: r.apiUrl, credentials: r.credentials, identity: r.identity ?? null, key: r.key ?? null, database: r.health.database ?? null },
        () => {
          ctx.out.success(`Logged in to ${r.apiUrl}`);
          if (r.identity) ctx.out.info(`  ${r.identity.actor} (${r.identity.role}) · ${r.identity.organization.name}`);
          if (r.key) ctx.out.info(`  API key: ${r.key.name} (${r.key.prefix})`);
          ctx.out.info(ctx.out.dim('  Next: `tokenistt connect` to discover your workspaces and projects, `tokenistt doctor` to verify the setup.'));
        },
      );
    });

  program
    .command('logout')
    .description('Remove stored credentials from this machine')
    .action((_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const { removed } = logout(ctx.env);
      const envSet = ctx.config.fromEnv.filter((n) => n !== 'TOKENISTT_API_URL');
      ctx.out.result({ ok: true, removed, environment_credentials_remain: envSet }, () => {
        if (removed) ctx.out.success('Credentials removed.');
        else ctx.out.info('No stored credentials.');
        if (envSet.length) ctx.out.warn(`Still set in the environment: ${envSet.join(', ')}`);
      });
    });

  const auth = program.command('auth').description('Inspect and configure authentication');

  auth
    .command('status')
    .description('Show which credentials are in effect (local; makes no network call)')
    .action((_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const s = authStatus(ctx.config);
      ctx.out.result(s, () => {
        ctx.out.line(`${ctx.out.bold('Gateway')}  ${s.apiUrl}`);
        if (!s.authenticated) {
          ctx.out.line('Not authenticated. Run `tokenistt login`.');
          return;
        }
        ctx.out.table(s.credentials.map((c) => ({ ...c, expires: c.expired ? `EXPIRED ${c.expiresAt}` : c.expiresAt ?? '–' })), [
          { key: 'kind', header: 'Credential' }, { key: 'preview', header: 'Value' }, { key: 'from', header: 'From' }, { key: 'expires', header: 'Expires' },
        ]);
      });
      if (!s.authenticated) process.exitCode = ExitCode.Auth;
    });

  auth
    .command('whoami')
    .description('Ask the gateway who you are (actor, role, organization)')
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const w = await whoami(ctx.makeClient());
      ctx.out.result(w, () => {
        ctx.out.line(`${w.actor}  (${w.role}${w.operator ? ', operator' : ''})`);
        ctx.out.line(`${w.organization.name}  [${w.organization.slug}]  id ${w.organization.id}`);
      });
    });

  auth
    .command('configure')
    .description('Change non-secret settings (gateway URL, organization id)')
    .option('--org-id <id>', 'numeric organization id used with an admin secret')
    .action((flags: { orgId?: string }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const apiUrl = (cmd.optsWithGlobals() as { apiUrl?: string }).apiUrl;
      if (!apiUrl && !flags.orgId) throw new UsageError('Nothing to change.', 'Pass --api-url <url> and/or --org-id <id>.');
      if (apiUrl && !/^https?:\/\//.test(apiUrl)) throw new UsageError('--api-url must start with http:// or https://.');
      if (flags.orgId && !/^\d+$/.test(flags.orgId)) throw new UsageError('--org-id must be numeric.');
      const stored = readProfile(ctx.env) ?? { apiUrl: DEFAULT_API_URL };
      writeProfile({ ...stored, apiUrl: apiUrl ? apiUrl.replace(/\/+$/, '') : stored.apiUrl, organizationId: flags.orgId ?? stored.organizationId }, ctx.env);
      ctx.out.result({ ok: true }, () => ctx.out.success('Settings saved. Run `tokenistt doctor` to verify.'));
    });
}
