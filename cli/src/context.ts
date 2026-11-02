/** Per-invocation wiring: global flags -> Output, resolved config, API client. Commands receive this, never globals. */
import { ApiClient } from './api/client.js';
import { Output, shouldUseColor } from './core/output.js';
import { resolveConfig, type ResolvedConfig } from './config/store.js';

export interface GlobalOptions {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean; // commander sets false for --no-color
  apiUrl?: string;
}

export interface Context {
  out: Output;
  env: NodeJS.ProcessEnv;
  config: ResolvedConfig;
  makeClient: (cfg?: ResolvedConfig) => ApiClient;
  version: string;
}

export function createContext(opts: GlobalOptions, version: string, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Context {
  const out = new Output({
    json: opts.json,
    quiet: opts.quiet,
    verbose: opts.verbose,
    color: shouldUseColor(env, process.stdout.isTTY, opts.color === false),
  });
  const config = resolveConfig(env);
  if (opts.apiUrl) config.apiUrl = opts.apiUrl.replace(/\/+$/, '');
  return {
    out,
    env,
    config,
    version,
    makeClient: (cfg = config) => new ApiClient(cfg, { userAgent: `tokenistt-cli/${version}`, log: (l) => out.debug(l), fetch: fetchImpl }),
  };
}
