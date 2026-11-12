#!/usr/bin/env node
// One-command first run:  node scripts/setup.mjs   (or: npm run setup)
// Creates .env from .env.example with freshly generated secrets. Never overwrites an existing .env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

const hex = () => randomBytes(32).toString('hex');

if (existsSync(envPath)) {
  // Never overwrite, but add secrets introduced by newer versions so `docker compose up` keeps working.
  let env = readFileSync(envPath, 'utf8');
  const added = [];
  for (const key of ['REDIS_PASSWORD', 'METRICS_TOKEN']) {
    if (!new RegExp(String.raw`^${key}=[^\s#]`, 'm').test(env)) {
      env = env.replace(new RegExp(String.raw`^${key}=.*(\r?\n|$)`, 'm'), '');
      env += (env.endsWith('\n') || env === '' ? '' : '\n') + `${key}=${hex()}\n`;
      added.push(key);
    }
  }
  if (added.length) {
    writeFileSync(envPath, env, { mode: 0o600 });
    console.log(`.env already exists — kept it and added: ${added.join(', ')}.`);
  } else {
    console.log('.env already exists — leaving it alone.');
  }
} else {
  const secrets = ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'METRICS_TOKEN', 'ADMIN_SECRET', 'MASTER_KEY', 'ENCRYPTION_KEY', 'JWT_SECRET'];
  let env = readFileSync(examplePath, 'utf8');
  for (const key of secrets) {
    env = env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${hex()}`);
  }
  writeFileSync(envPath, env, { mode: 0o600 });
  console.log('Created .env with generated secrets.');
}

console.log(`
Next:
  docker compose up --build -d
  docker compose --profile demo up seed     # optional: synthetic sample data

  Dashboard  http://localhost:3001   first visit: create the owner account; the setup token is
                                     ADMIN_SECRET from your .env
  Gateway    http://localhost:3000
  Ports bind to 127.0.0.1 only. To serve other machines, see docs/DEPLOYMENT.md.
`);
