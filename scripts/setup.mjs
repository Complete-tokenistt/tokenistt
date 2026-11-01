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

if (existsSync(envPath)) {
  console.log('.env already exists — leaving it alone.');
} else {
  const secrets = ['POSTGRES_PASSWORD', 'ADMIN_SECRET', 'MASTER_KEY', 'ENCRYPTION_KEY', 'JWT_SECRET'];
  let env = readFileSync(examplePath, 'utf8');
  for (const key of secrets) {
    env = env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${randomBytes(32).toString('hex')}`);
  }
  writeFileSync(envPath, env, { mode: 0o600 });
  console.log('Created .env with generated secrets.');
}

console.log(`
Next:
  docker compose up --build -d
  docker compose --profile demo up seed     # optional: synthetic sample data

  Dashboard  http://localhost:3001   (no login by default — see AUTH_MODE in .env)
  Gateway    http://localhost:3000
`);
