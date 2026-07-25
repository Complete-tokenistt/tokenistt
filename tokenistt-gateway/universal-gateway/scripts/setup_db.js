import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load .env variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('Error: DATABASE_URL is not set in .env');
  process.exit(1);
}

const { Client } = pg;

async function run() {
  console.log('Connecting to database...');
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  console.log('Connected successfully!');

  try {
    // 1. Run 0000_init.sql
    const initSqlPath = path.resolve(__dirname, '../../../tokenistt-sdk/db/drizzle/0000_init.sql');
    console.log(`Reading schema from ${initSqlPath}...`);
    const initSql = fs.readFileSync(initSqlPath, 'utf8');
    
    console.log('Applying 0000_init.sql (tables and functions)...');
    await client.query(initSql);
    console.log('Schema applied successfully.');

    // 2. Run views.sql
    const viewsSqlPath = path.resolve(__dirname, '../../../tokenistt-sdk/db/drizzle/views.sql');
    console.log(`Reading views from ${viewsSqlPath}...`);
    const viewsSql = fs.readFileSync(viewsSqlPath, 'utf8');
    
    console.log('Applying views.sql (materialized views)...');
    await client.query(viewsSql);
    console.log('Views applied successfully.');

    // 3. Seed demo data
    console.log('Seeding demo data...');

    // Clean existing seed data (optional, but good for idempotency)
    console.log('Cleaning old seed data...');
    await client.query('DELETE FROM virtual_keys');
    await client.query('DELETE FROM workspaces');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM organizations');

    // Create ACME Organization
    const acmeOrgResult = await client.query(
      "INSERT INTO organizations (name, slug) VALUES ('ACME Corp', 'acme') RETURNING id"
    );
    const acmeOrgId = acmeOrgResult.rows[0].id;

    // Create Globex Organization
    const globexOrgResult = await client.query(
      "INSERT INTO organizations (name, slug) VALUES ('Globex Corp', 'globex') RETURNING id"
    );
    const globexOrgId = globexOrgResult.rows[0].id;

    // Create ACME Users
    const janeResult = await client.query(
      "INSERT INTO users (organization_id, email, display_name, external_ref) VALUES ($1, 'jane@example.com', 'Jane Doe', 'jane') RETURNING id",
      [acmeOrgId]
    );
    const janeId = janeResult.rows[0].id;

    const johnResult = await client.query(
      "INSERT INTO users (organization_id, email, display_name, external_ref) VALUES ($1, 'john@example.com', 'John Smith', 'john') RETURNING id",
      [acmeOrgId]
    );
    const johnId = johnResult.rows[0].id;

    const disabledUserResult = await client.query(
      "INSERT INTO users (organization_id, email, display_name, external_ref) VALUES ($1, 'disabled@example.com', 'Disabled User', 'disabled') RETURNING id",
      [acmeOrgId]
    );
    const disabledUserId = disabledUserResult.rows[0].id;

    // Create Globex User
    const aliceResult = await client.query(
      "INSERT INTO users (organization_id, email, display_name, external_ref) VALUES ($1, 'alice@example.com', 'Alice Vance', 'alice') RETURNING id",
      [globexOrgId]
    );
    const aliceId = aliceResult.rows[0].id;

    // Create Workspaces
    const acmeSupportWorkspaceResult = await client.query(
      "INSERT INTO workspaces (organization_id, name, cost_center, budget_cap_usd) VALUES ($1, 'Engineering', 'CC-4401-Support', 1000.00) RETURNING id",
      [acmeOrgId]
    );
    const acmeSupportWorkspaceId = acmeSupportWorkspaceResult.rows[0].id;

    const globexSalesWorkspaceResult = await client.query(
      "INSERT INTO workspaces (organization_id, name, cost_center, budget_cap_usd) VALUES ($1, 'Sales', 'CC-8802-Sales', 2000.00) RETURNING id",
      [globexOrgId]
    );
    const globexSalesWorkspaceId = globexSalesWorkspaceResult.rows[0].id;

    // Create Virtual Keys
    // Key 1: Jane (Active, $87.50 budget)
    await client.query(
      `INSERT INTO virtual_keys (
        organization_id, workspace_id, owner_user_id, name, key_prefix, key_hash, budget_cap_usd, budget_period, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        acmeOrgId,
        acmeSupportWorkspaceId,
        janeId,
        "Jane's Dev Key",
        'tktt_live_acme_jane_abc123def456',
        'dummy_hash',
        87.50,
        'monthly',
        'active',
        JSON.stringify({ enforcement_mode: 'hard_cap', real_api_key: null })
      ]
    );

    // Key 2: John (Active, $12.30 budget)
    await client.query(
      `INSERT INTO virtual_keys (
        organization_id, workspace_id, owner_user_id, name, key_prefix, key_hash, budget_cap_usd, budget_period, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        acmeOrgId,
        acmeSupportWorkspaceId,
        johnId,
        "John's Dev Key",
        'tktt_live_acme_john_xyz789uvw012',
        'dummy_hash',
        12.30,
        'monthly',
        'active',
        JSON.stringify({ enforcement_mode: 'hard_cap', real_api_key: null })
      ]
    );

    // Key 3: Alice (Active, $450.00 budget)
    await client.query(
      `INSERT INTO virtual_keys (
        organization_id, workspace_id, owner_user_id, name, key_prefix, key_hash, budget_cap_usd, budget_period, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        globexOrgId,
        globexSalesWorkspaceId,
        aliceId,
        "Alice's Production Key",
        'tktt_live_globex_alice_qrs456tuv789',
        'dummy_hash',
        450.00,
        'monthly',
        'active',
        JSON.stringify({ enforcement_mode: 'hard_cap', real_api_key: null })
      ]
    );

    // Key 4: Disabled (Revoked)
    await client.query(
      `INSERT INTO virtual_keys (
        organization_id, workspace_id, owner_user_id, name, key_prefix, key_hash, budget_cap_usd, budget_period, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        acmeOrgId,
        acmeSupportWorkspaceId,
        disabledUserId,
        "Disabled Key",
        'tktt_live_acme_disabled_mno321pqr654',
        'dummy_hash',
        100.00,
        'monthly',
        'revoked',
        JSON.stringify({ enforcement_mode: 'hard_cap', real_api_key: null })
      ]
    );

    console.log('Database successfully initialized and seeded with all demo keys!');
  } catch (err) {
    console.error('Error running setup:', err);
  } finally {
    await client.end();
  }
}

run();
