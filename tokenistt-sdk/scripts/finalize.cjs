#!/usr/bin/env node
/* eslint-disable */
/**
 * Post-build finalize for the dual (CJS + ESM) bundle:
 *
 *  1. CJS: reassign `module.exports` to the default export (the Tokenistt
 *     class) and copy the named exports onto it as statics. This makes
 *     `const Tokenistt = require('@tokenistt/sdk')` return the class directly
 *     — exactly like `openai` — while still allowing
 *     `const { Tokenistt, ChatCompletionStream } = require(...)`.
 *
 *  2. ESM: drop a `package.json` with `"type": "module"` into dist/esm so the
 *     emitted `.js` files are interpreted as ESM (no `"type":"module"` at the
 *     package root, which would otherwise break the CJS build).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cjsIndex = path.join(root, 'dist', 'cjs', 'index.js');
const esmDir = path.join(root, 'dist', 'esm');

// 1. Finalize CJS entry.
if (fs.existsSync(cjsIndex)) {
  const src = fs.readFileSync(cjsIndex, 'utf8');
  const footer = `
// --- @tokenistt/sdk: CJS drop-in finalize ---
if (typeof module !== 'undefined' && module.exports && module.exports.default) {
  const _def = module.exports.default;
  for (const _k of Object.keys(module.exports)) {
    if (_k !== 'default') _def[_k] = module.exports[_k];
  }
  _def.default = _def;
  module.exports = _def;
}
`;
  if (!src.includes('@tokenistt/sdk: CJS drop-in finalize')) {
    fs.writeFileSync(cjsIndex, src + footer, 'utf8');
  }
  console.log('finalize: CJS entry patched at', cjsIndex);
} else {
  console.warn('finalize: CJS entry not found at', cjsIndex);
}

// 2. Mark ESM dir as ESM.
if (fs.existsSync(esmDir)) {
  fs.writeFileSync(
    path.join(esmDir, 'package.json'),
    JSON.stringify({ type: 'module' }, null, 2) + '\n',
    'utf8',
  );
  console.log('finalize: wrote', path.join(esmDir, 'package.json'));
}
