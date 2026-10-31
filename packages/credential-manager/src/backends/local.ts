import crypto from "crypto";
import type { CryptoBackend } from "../types";
import { MASTER_KEY } from "../config";

// DEV-ONLY backend. AES-256-GCM with a key DERIVED PER ORG from MASTER_KEY
// (HKDF), so ciphertext for org A is undecryptable by org B. Not for production —
// use `vault` or `kms` in real deployments.
function keyForOrg(orgId: string): Buffer {
  // hkdfSync returns an ArrayBuffer, not a Buffer
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(MASTER_KEY), Buffer.from(orgId), Buffer.alloc(0), 32));
}

interface LocalBlob {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export const localBackend: CryptoBackend = {
  name: "local",

  async encrypt(orgId: string, plaintext: string): Promise<string> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", keyForOrg(orgId), iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob: LocalBlob = {
      v: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: enc.toString("base64"),
    };
    return JSON.stringify(blob);
  },

  async decrypt(orgId: string, blob: string): Promise<string> {
    const o = JSON.parse(blob) as LocalBlob;
    const iv = Buffer.from(o.iv, "base64");
    const tag = Buffer.from(o.tag, "base64");
    const data = Buffer.from(o.data, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyForOrg(orgId), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  },

  // Root-key rotation is a Vault/KMS concept; local has no equivalent.
};
