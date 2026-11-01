const esbuild = require('esbuild');
esbuild.buildSync({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
});
console.log('built out/extension.js');
