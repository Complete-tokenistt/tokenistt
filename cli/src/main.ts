import { execute } from './program.js';

export async function run(argv: string[]): Promise<void> {
  const code = await execute(argv);
  // Let stdout flush; do not call process.exit() with pending writes.
  process.exitCode = code;
}

// Allow `tsx src/main.ts …` during development and tests.
if (process.argv[1] && /main\.(ts|js)$/.test(process.argv[1])) void run(process.argv);
