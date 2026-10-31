import crypto from 'crypto';

interface LocalBlob {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

function keyForOrg(orgId: string, masterKey: string): any {
  return crypto.hkdfSync("sha256", Buffer.from(masterKey) as any, Buffer.from(orgId) as any, Buffer.alloc(0) as any, 32);
}

export function encryptApiKey(plaintext: string, orgId: string): string {
  const masterKey = process.env.MASTER_KEY || 'default-master-key-change-in-production';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyForOrg(orgId, masterKey) as any, iv as any);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8") as any, cipher.final() as any]);
  const tag = cipher.getAuthTag();
  const blob: LocalBlob = {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  };
  return JSON.stringify(blob);
}
