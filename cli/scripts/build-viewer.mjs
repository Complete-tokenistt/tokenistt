// Bundles the browser viewer so it works with no network: no CDN, nothing fetched at runtime.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(cli, 'dist', 'viewer-assets');
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(cli, 'viewer', 'app.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  outfile: join(out, 'app.js'),
  logLevel: 'warning',
});
for (const f of ['index.html', 'style.css']) copyFileSync(join(cli, 'viewer', f), join(out, f));
