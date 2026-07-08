import { randomUUID } from "crypto";
import type {
  CredentialRecord,
  CredentialVersion,
  CryptoBackend,
} from "./types";
import { jsonStore } from "./store";
import { HttpError } from "./types";

// Orchestrates metadata storage + the crypto backend. Every operation is
// scoped by (orgId, provider); the backend enforces per-org crypto isolation.
export class CredentialService {
  constructor(private backend: CryptoBackend) {}

  private now(): string {
    return new Date().toISOString();
  }

  async store(
    orgId: string,
    provider: string,
    apiKey: string,
    meta?: Record<string, unknown>,
  ) {
    if (!apiKey) throw new HttpError(400, "apiKey is required");
    const existing = jsonStore.get(orgId, provider);
    const blob = await this.backend.encrypt(orgId, apiKey);

    const record: CredentialRecord =
      existing ?? {
        id: randomUUID(),
        orgId,
        provider,
        versions: [],
        activeVersion: 0,
        createdAt: this.now(),
        updatedAt: this.now(),
      };

    const version = record.versions.length + 1;
    const v: CredentialVersion = {
      version,
      encryptedBlob: blob,
      createdAt: this.now(),
      meta,
    };
    record.versions.push(v);
    record.activeVersion = version; // newest becomes active
    record.updatedAt = this.now();
    jsonStore.put(record);

    return { id: record.id, orgId, provider, version, active: true };
  }

  // Returns the decrypted ACTIVE key (for gateway use on a trusted network).
  async getActive(orgId: string, provider: string) {
    const r = jsonStore.get(orgId, provider);
    if (!r) throw new HttpError(404, "credential not found");
    const v = r.versions.find((x) => x.version === r.activeVersion);
    if (!v) throw new HttpError(404, "no active version");
    const apiKey = await this.backend.decrypt(orgId, v.encryptedBlob);
    return { orgId, provider, apiKey, version: v.version, createdAt: v.createdAt };
  }

  // Metadata only — never returns plaintext.
  async listVersions(orgId: string, provider: string) {
    const r = jsonStore.get(orgId, provider);
    if (!r) throw new HttpError(404, "credential not found");
    return r.versions.map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      meta: v.meta,
    }));
  }

  // Rotation: appends a new version and flips active. Prior versions are kept
  // so the gateway can fall back (zero-downtime key rotation).
  async rotate(
    orgId: string,
    provider: string,
    apiKey: string,
    meta?: Record<string, unknown>,
  ) {
    return this.store(orgId, provider, apiKey, meta);
  }

  async delete(orgId: string, provider: string) {
    const r = jsonStore.get(orgId, provider);
    if (!r) throw new HttpError(404, "credential not found");
    jsonStore.delete(orgId, provider);
  }

  // Rotate the root key (Vault transit / KMS key). Transparent to stored blobs.
  async rotateRoot(orgId: string) {
    if (this.backend.rotateRoot) await this.backend.rotateRoot(orgId);
  }
}
