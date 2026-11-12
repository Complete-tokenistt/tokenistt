#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`tokenistt needs Node.js 22.13 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}
// Hooks run on every agent event, so they skip argument parsing and everything else.
if (process.argv[2] === 'hook') import('../dist/agents/hook-main.js').then((m) => m.runHook(process.argv));
else if (process.argv[2] === 'statusline') import('../dist/agents/statusline.js').then((m) => m.runStatusLine());
else import('../dist/main.js').then((m) => m.run(process.argv));
