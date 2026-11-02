import { Command, CommanderError } from 'commander';
import { createRequire } from 'node:module';
import { CliError, ExitCode } from './core/errors.js';
import { Output, shouldUseColor } from './core/output.js';
import { createContext, type Context, type GlobalOptions } from './context.js';
import { registerAuth } from './commands/auth.js';
import { registerConnect } from './commands/connect.js';
import { registerGraph } from './commands/graph.js';
import { registerInit } from './commands/init.js';
import { registerMap } from './commands/map.js';

const require = createRequire(import.meta.url);
export const VERSION: string = (require('../package.json') as { version: string }).version;

export interface ProgramDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export function buildProgram(deps: ProgramDeps = {}): Command {
  const env = deps.env ?? process.env;
  const program = new Command('tokenistt')
    .description('Open-source AI cost visibility and governance, with developer intelligence for your repositories')
    .version(VERSION, '-V, --version')
    .option('--json', 'machine-readable output on stdout')
    .option('--quiet', 'suppress informational output')
    .option('--verbose', 'debug output on stderr (secrets redacted)')
    .option('--no-color', 'disable coloured output')
    .option('--api-url <url>', 'gateway URL (overrides TOKENISTT_API_URL and the saved config)')
    .showHelpAfterError('(add --help for usage)')
    .exitOverride();

  const getCtx = (cmd: Command): Context => createContext(cmd.optsWithGlobals() as GlobalOptions, VERSION, env, deps.fetch);

  registerAuth(program, getCtx);
  registerConnect(program, getCtx);
  registerInit(program, getCtx);
  registerMap(program, getCtx);
  registerGraph(program, getCtx);
  return program;
}

/** Parse and run; returns the process exit code instead of exiting so it can be tested. */
export async function execute(argv: string[], deps: ProgramDeps = {}): Promise<number> {
  const program = buildProgram(deps);
  const wantsJson = argv.includes('--json');
  const out = new Output({ json: wantsJson, color: shouldUseColor(deps.env ?? process.env, process.stderr.isTTY, argv.includes('--no-color')), verbose: argv.includes('--verbose') });
  // Commands report non-fatal outcomes (offline, unauthorized) via process.exitCode; collect and restore it
  // so callers (and tests) decide what the real process exit code is.
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / --version exit 0; real usage mistakes are already printed by commander
      return err.exitCode === 0 ? 0 : ExitCode.Usage;
    }
    if (err instanceof CliError) {
      out.error(err.message, err.hint, err.exitCode);
      return err.exitCode;
    }
    out.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`, 'Re-run with --verbose; if it persists, please open an issue.', ExitCode.Error);
    if (out.verbose && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    return ExitCode.Error;
  } finally {
    process.exitCode = previous;
  }
}
