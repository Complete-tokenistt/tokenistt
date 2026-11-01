-- Supports "last used" per API key (GET /v1/admin/keys) without scanning the ledger.
CREATE INDEX IF NOT EXISTS ix_txn_vkey_created ON transactions (virtual_key_id, created_at DESC);
