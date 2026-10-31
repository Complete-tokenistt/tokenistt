// Shared types for the credential manager.

// Crypto backend: encrypts/decrypts a plaintext provider key into an opaque
// storable blob. Isolation is enforced per orgId by every backend.
export interface CryptoBackend {
  name: string;
  encrypt(orgId: string, plaintext: string): Promise<string>;
  decrypt(orgId: string, blob: string): Promise<string>;
  // Optional: rotate the root key (Vault transit / KMS key rotation).
  rotateRoot?(orgId: string): Promise<void>;
}

export interface CredentialVersion {
  version: number;
  encryptedBlob: string; // backend-specific opaque ciphertext
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface CredentialRecord {
  id: string;
  orgId: string;
  provider: string; // "openai" | "anthropic" | ...
  versions: CredentialVersion[];
  activeVersion: number;
  createdAt: string;
  updatedAt: string;
}

// Thrown by the service; mapped to HTTP status in the server.
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
