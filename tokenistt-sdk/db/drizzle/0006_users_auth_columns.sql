-- =============================================================================
-- 0006_users_auth_columns.sql
-- Add authentication columns and role-based access control to users table.
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'viewer'
  CHECK (role IN ('owner', 'admin', 'finance', 'developer', 'viewer'));

CREATE INDEX IF NOT EXISTS ix_users_org_email ON users (organization_id, email);
