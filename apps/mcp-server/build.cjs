const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts')).map(f => path.join('src', f));

// Also compile transports/sse.ts
if (fs.existsSync(path.join(srcDir, 'transports', 'sse.ts'))) {
  files.push(path.join('src', 'transports', 'sse.ts'));
}

esbuild.buildSync({
  entryPoints: files,
  outdir: 'dist',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
});

console.log('Tokenistt MCP Server built successfully to dist/ via esbuild!');

