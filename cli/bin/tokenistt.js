#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`tokenistt needs Node.js 22.13 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}
import('../dist/main.js').then((m) => m.run(process.argv));
