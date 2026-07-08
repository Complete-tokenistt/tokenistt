import {
  KMSClient,
  EncryptCommand,
  DecryptCommand,
  EnableKeyRotationCommand,
} from "@aws-sdk/client-kms";
import type { CryptoBackend } from "../types";
import { AWS_REGION, AWS_KMS_KEY_ARN_PREFIX } from "../config";

// AWS KMS backend. A PER-ORG KMS key (derived as PREFIX + orgId) provides
// cryptographic isolation; KMS is the root of trust and handles rotation.
const client = new KMSClient({ region: AWS_REGION });

function keyId(orgId: string): string {
  return `${AWS_KMS_KEY_ARN_PREFIX}${orgId}`;
}

export const kmsBackend: CryptoBackend = {
  name: "kms",

  async encrypt(orgId: string, plaintext: string): Promise<string> {
    const res = await client.send(
      new EncryptCommand({ KeyId: keyId(orgId), Plaintext: Buffer.from(plaintext) }),
    );
    return (res.CiphertextBlob as Uint8Array).toString("base64");
  },

  async decrypt(orgId: string, blob: string): Promise<string> {
    const res = await client.send(
      new DecryptCommand({ CiphertextBlob: Buffer.from(blob, "base64") }),
    );
    return (res.Plaintext as Uint8Array).toString("utf8");
  },

  async rotateRoot(orgId: string): Promise<void> {
    // Enable (idempotent) automatic annual rotation for the org's KMS key.
    await client.send(
      new EnableKeyRotationCommand({ KeyId: keyId(orgId) }),
    );
  },
};
