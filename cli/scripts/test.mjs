// Runs the CLI test suite. The CLI needs node:sqlite (Node 22.13+), while the monorepo's main CI job is on
// Node 20 for the gateway, so older runtimes skip visibly here; the dedicated `cli` CI job runs everything.
import { spawnSync } from 'node:child_process';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.log(`SKIPPED: tokenistt CLI tests need Node 22.13+ (running ${process.versions.node}); covered by the "cli" CI job.`);
  process.exit(0);
}
const files = process.argv.slice(2);
const args = ['--import', 'tsx', '--test', '--test-timeout=60000', ...(files.length ? files : ['tests/**/*.test.ts'])];
const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
