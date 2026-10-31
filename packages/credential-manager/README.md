# Tokenistt Credential Manager (Prompt 11 — Phase 5)

A secure vault for customers' **real provider API keys** (OpenAI `sk-...`,
Anthropic `sk-ant-api03-...`, etc.). Keys are encrypted at rest via
**HashiCorp Vault Transit** or **AWS KMS**, support **rotation without
downtime**, and are **isolated per tenant** (orgs never share keys).

## Your requirements → implementation

| Requirement | Where |
| --- | --- |
| **HashiCorp Vault or AWS KMS** | `src/backends/vault.ts` (Transit) / `src/backends/kms.ts` (KMS); selectable via `CRED_BACKEND` |
| **Encrypt at rest (`sk-ant-api03-…`)** | `src/service.ts` encrypts before storing; only opaque ciphertext is persisted (`data/credentials.json`) |
| **Rotation without downtime** | `rotate()` appends a new version + flips active; prior versions retained for gateway fallback; `rotateRoot()` rotates the Vault/KMS root key |
| **Multi-tenant isolation** | Per-org crypto key (Vault `tokenistt-<orgId>` / KMS key per org / HKDF-derived local key) + strict `orgId` validation on every route |

## Run

```bash
cd credential-manager
npm install
cp .env.example .env

# Dev (no Vault/KMS needed — AES-256-GCM, local master key):
CRED_BACKEND=local npm start

# Production — Vault:
CRED_BACKEND=vault VAULT_ADDR=http://localhost:8200 VAULT_TOKEN=<token> npm start

# Production — AWS KMS:
CRED_BACKEND=kms AWS_REGION=us-east-1 AWS_KMS_KEY_ARN_PREFIX=arn:aws:kms:...:key/ npm start
```

## API

All routes are org-scoped; `orgId` is validated and never crossed.

```bash
# Store a customer's Anthropic key for org "acme"
curl -X POST localhost:4000/v1/credentials \
  -H 'content-type: application/json' \
  -d '{"orgId":"acme","provider":"anthropic","apiKey":"sk-ant-api03-xxxx"}'

# Retrieve the active (decrypted) key — for the gateway, on a trusted network
curl localhost:4000/v1/credentials/acme/anthropic

# List versions (metadata only, no plaintext)
curl localhost:4000/v1/credentials/acme/anthropic/versions

# Rotate the provider key (keeps old versions)
curl -X POST localhost:4000/v1/credentials/acme/anthropic/rotate \
  -H 'content-type: application/json' -d '{"apiKey":"sk-ant-api03-NEWxxxx"}'

# Rotate the root key (Vault transit / KMS key rotation) — transparent to blobs
curl -X POST localhost:4000/v1/credentials/acme/rotate-root

# Delete
curl -X DELETE localhost:4000/v1/credentials/acme/anthropic
```

## Security notes

- **At rest:** only the ciphertext blob is stored. The plaintext key exists in
  memory only during encrypt/decrypt; the root key never leaves Vault/KMS.
- **Isolation:** even with the same `MASTER_KEY`, org A cannot decrypt org B's
  blob (per-org key derivation). With Vault/KMS, isolation is enforced by the
  vault itself via per-org keys/policies.
- **Rotation:** the gateway should read the active version and fall back to the
  previous version if a call fails — this gives zero-downtime rotation.
- **Transport:** this service must run on a private network (mTLS / service
  mesh). The `GET active` endpoint returns the plaintext key for the gateway;
  do not expose it publicly.
- **Backend is fixed per environment:** the stored ciphertext is backend-specific
  (Vault vs KMS vs local) — don't switch backends on existing data.
- The `local` backend is **dev-only**; use `vault` or `kms` in production.
