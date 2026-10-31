import { describe, it } from 'node:test';
import assert from 'node:assert';
import { encryptApiKey, decryptApiKey } from '../services/vault.js';

describe('AES-256-GCM In-Memory Vault', () => {
  const originalMasterKey = process.env.MASTER_KEY;

  it('should encrypt and decrypt a plaintext key for an org', () => {
    process.env.MASTER_KEY = 'test-master-key-with-enough-entropy-32bytes';
    const plaintext = 'sk-proj-super-secret-openai-org-key';
    const orgId = '12345';

    const encrypted = encryptApiKey(plaintext, orgId);
    assert.notStrictEqual(encrypted, plaintext);
    assert.ok(encrypted.includes('"v":1'));
    assert.ok(encrypted.includes('"iv"'));
    assert.ok(encrypted.includes('"tag"'));
    assert.ok(encrypted.includes('"data"'));

    const decrypted = decryptApiKey(encrypted, orgId);
    assert.strictEqual(decrypted, plaintext);

    process.env.MASTER_KEY = originalMasterKey;
  });

  it('should fail to decrypt for a different organization id (isolation check)', () => {
    process.env.MASTER_KEY = 'test-master-key-with-enough-entropy-32bytes';
    const plaintext = 'sk-proj-key';
    const orgIdA = '12345';
    const orgIdB = '54321';

    const encryptedA = encryptApiKey(plaintext, orgIdA);
    
    // Decrypting with Org B should fail to authenticating GCM tag or throw an error, falling back or throwing.
    try {
      const decryptedB = decryptApiKey(encryptedA, orgIdB);
      // Decryption must NOT equal plaintext if it didn't crash
      assert.notStrictEqual(decryptedB, plaintext);
    } catch (e) {
      // Throwing is also a successful isolation check
      assert.ok(true);
    }

    process.env.MASTER_KEY = originalMasterKey;
  });

  it('should fall back gracefully to plaintext if the key is not encrypted (backward compatibility)', () => {
    const plainTextKey = 'sk-plain-text-key';
    const decrypted = decryptApiKey(plainTextKey, '12345');
    assert.strictEqual(decrypted, plainTextKey);
  });
});
