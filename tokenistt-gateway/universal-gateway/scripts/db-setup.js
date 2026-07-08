import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const connectionString = 'postgresql://postgres:Aryan%23101@localhost:5432/postgres';

async function run() {
  console.log('Connecting to PostgreSQL database...');
  const client = new pg.Client({ connectionString });
  
  try {
    await client.connect();
    console.log('Connected successfully!');

    // 1. Read and run 0000_init.sql
    const initSqlPath = path.resolve(__dirname, '../../../tokenistt-sdk/db/drizzle/0000_init.sql');
    console.log(`Reading DDL schema from: ${initSqlPath}`);
    const initSql = fs.readFileSync(initSqlPath, 'utf8');
    
    console.log('Applying 0000_init.sql schema (creating tables, functions, etc.)...');
    await client.query(initSql);
    console.log('0000_init.sql applied successfully!');

    // 2. Read and run views.sql
    const viewsSqlPath = path.resolve(__dirname, '../../../tokenistt-sdk/db/drizzle/views.sql');
    console.log(`Reading materialized views from: ${viewsSqlPath}`);
    const viewsSql = fs.readFileSync(viewsSqlPath, 'utf8');

    console.log('Applying views.sql schema (creating materialized views)...');
    await client.query(viewsSql);
    console.log('views.sql applied successfully!');

    // 3. Seed default data for test authentication
    console.log('Seeding default test data (org, workspace, and virtual key)...');
    const seedSql = `
      -- Seed Organization
      INSERT INTO organizations (name, slug) 
      VALUES ('Default Org', 'default') 
      ON CONFLICT (slug) DO NOTHING;

      -- Seed Workspace
      INSERT INTO workspaces (organization_id, name, cost_center)
      SELECT id, 'Development', 'onboarding' 
      FROM organizations 
      WHERE slug = 'default'
      ON CONFLICT (organization_id, cost_center) DO NOTHING;

      -- Seed Virtual Key
      INSERT INTO virtual_keys (organization_id, workspace_id, name, key_prefix, key_hash, status)
      SELECT 
        o.id, 
        w.id, 
        'Default Test Key', 
        'tktt_live_default_user_12345', 
        'default_hash', 
        'active'
      FROM organizations o
      JOIN workspaces w ON w.organization_id = o.id
      WHERE o.slug = 'default' AND w.cost_center = 'onboarding'
        AND NOT EXISTS (
          SELECT 1 FROM virtual_keys WHERE key_prefix = 'tktt_live_default_user_12345'
        );
    `;
    await client.query(seedSql);
    console.log('Seeding completed successfully!');

    console.log('\nDatabase setup and seeding completed successfully! Your schema is ready.');
  } catch (err) {
    console.error('Error during database initialization:', err);
  } finally {
    await client.end();
  }
}

run();
