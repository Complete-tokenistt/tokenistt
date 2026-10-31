import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateVirtualKey, hashToken, verifyTokenHash } from '../services/keyManager.js';
import { parseToken } from '../db/auth.js';

describe('Key Manager (Cryptographic Key Vault)', () => {
  it('should generate a unique raw token on each call with proper format', () => {
    const key1 = generateVirtualKey('org_1', 'user_a');
    const key2 = generateVirtualKey('org_1', 'user_a');

    assert.ok(key1.rawToken.startsWith('tktt_live_org1_usera_'));
    assert.ok(key2.rawToken.startsWith('tktt_live_org1_usera_'));
    assert.notStrictEqual(key1.rawToken, key2.rawToken, 'Tokens should be distinct and random');
    assert.notStrictEqual(key1.keyHash, key2.keyHash, 'Hashes should be distinct');
  });

  it('should not expose full secret in keyPrefix', () => {
    const key = generateVirtualKey('workspace_sales', 'lead');
    assert.ok(key.keyPrefix.endsWith('...'));
    assert.ok(key.keyPrefix.length < key.rawToken.length);
    assert.notStrictEqual(key.keyPrefix, key.rawToken);
  });

  it('should produce deterministic SHA-256 hashes', () => {
    const raw = 'tktt_live_sample_token_secret_12345';
    const hash1 = hashToken(raw);
    const hash2 = hashToken(raw);

    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64); // 256 bits = 64 hex chars
  });

  it('should verify token hash correctly using timing-safe comparison', () => {
    const key = generateVirtualKey('org_test', 'tester');
    const isValid = verifyTokenHash(key.rawToken, key.keyHash);
    assert.strictEqual(isValid, true, 'Valid token should pass verification');

    const isInvalid = verifyTokenHash(key.rawToken + 'tampered', key.keyHash);
    assert.strictEqual(isInvalid, false, 'Tampered token must fail verification');
  });
});


describe('generated keys always parse (regression: base64url "-" broke ~40% of keys)', () => {
  it('1000 generated keys round-trip through parseToken', () => {
    for (let i = 0; i < 1000; i++) {
      const { rawToken } = generateVirtualKey(`org_${i}`, `user-${i}`);
      const parsed = parseToken(`Bearer ${rawToken}`);
      assert.ok(parsed, `token failed to parse: ${rawToken}`);
      assert.equal(parsed!.raw, rawToken);
    }
  });

  it('legacy tokens whose secret contains "-" now parse too', () => {
    assert.ok(parseToken('Bearer tktt_live_org1_alice_ab-cd_ef'));
  });
});
