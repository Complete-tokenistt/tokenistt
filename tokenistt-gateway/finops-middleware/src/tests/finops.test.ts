import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { 
  parseVirtualKeyToken,
  InMemoryVirtualKeyStore 
} from '../services/virtualKey.js';
import { VirtualKeyLookupResult } from '../types/index.js';

describe('Virtual Key Token Parser', () => {
  it('should parse valid live token', () => {
    const token = 'tktt_live_acme_jane_abc123def456';
    const result = parseVirtualKeyToken(token);
    
    assert.ok(result);
    assert.strictEqual(result.prefix, 'tktt_live');
    assert.strictEqual(result.workspace, 'acme');
    assert.strictEqual(result.userId, 'jane');
    assert.strictEqual(result.hash, 'abc123def456');
    assert.strictEqual(result.raw, token);
  });
  
  it('should parse valid test token', () => {
    const token = 'tktt_test_globex_bob_xyz789';
    const result = parseVirtualKeyToken(token);
    
    assert.ok(result);
    assert.strictEqual(result.prefix, 'tktt_test');
    assert.strictEqual(result.workspace, 'globex');
    assert.strictEqual(result.userId, 'bob');
    assert.strictEqual(result.hash, 'xyz789');
  });
  
  it('should parse token with Bearer prefix', () => {
    const token = 'Bearer tktt_live_acme_jane_abc123def456';
    const result = parseVirtualKeyToken(token);
    
    assert.ok(result);
    assert.strictEqual(result.workspace, 'acme');
    assert.strictEqual(result.userId, 'jane');
  });
  
  it('should parse token with underscores in userId', () => {
    const token = 'tktt_live_acme_john_doe_abc123';
    const result = parseVirtualKeyToken(token);
    
    assert.ok(result);
    assert.strictEqual(result.workspace, 'acme');
    assert.strictEqual(result.userId, 'john_doe');
    assert.strictEqual(result.hash, 'abc123');
  });
  
  it('should return null for invalid prefix', () => {
    const token = 'invalid_acme_jane_abc123';
    const result = parseVirtualKeyToken(token);
    assert.strictEqual(result, null);
  });
  
  it('should return null for test prefix with live indicator', () => {
    const token = 'tktt_live_invalid';
    const result = parseVirtualKeyToken(token);
    assert.strictEqual(result, null);
  });
  
  it('should return null for empty string', () => {
    const result = parseVirtualKeyToken('');
    assert.strictEqual(result, null);
  });
  
  it('should return null for undefined', () => {
    const result = parseVirtualKeyToken(undefined as unknown as string);
    assert.strictEqual(result, null);
  });
  
  it('should return null for token with too few parts', () => {
    const token = 'tktt_live_acme';
    const result = parseVirtualKeyToken(token);
    assert.strictEqual(result, null);
  });
});

describe('InMemoryVirtualKeyStore', () => {
  let store: InMemoryVirtualKeyStore;
  
  beforeEach(() => {
    store = new InMemoryVirtualKeyStore();
  });
  
  it('should find existing virtual key', async () => {
    const result = await store.findByToken('tktt_live_acme_jane_abc123def456');
    
    assert.ok(result);
    assert.strictEqual(result.virtualKeyId, 'vkey_001');
    assert.strictEqual(result.userId, 'user_jane');
    assert.strictEqual(result.costCenter, 'engineering');
    assert.strictEqual(result.budgetLimit, 100.00);
    assert.strictEqual(result.enabled, true);
  });
  
  it('should return null for non-existent key', async () => {
    const result = await store.findByToken('tktt_live_unknown_user_hash123');
    assert.strictEqual(result, null);
  });
  
  it('should find disabled key but with enabled=false', async () => {
    const result = await store.findByToken('tktt_live_acme_disabled_mno321pqr654');
    
    assert.ok(result);
    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.costCenter, 'deprecated');
  });
  
  it('should add new key', async () => {
    const newKey: VirtualKeyLookupResult = {
      virtualKeyId: 'vkey_new',
      realApiKey: 'tktt_live_newco_test_hash999',
      userId: 'user_test',
      workspace: 'newco',
      costCenter: 'testing',
      budgetLimit: 200.00,
      budgetRemaining: 200.00,
      budgetResetAt: new Date(),
      rateLimitPerMinute: 150,
      enabled: true,
    };
    
    store.addKey(newKey);
    
    const result = await store.findByToken('tktt_live_newco_test_hash999');
    assert.ok(result);
    assert.strictEqual(result.virtualKeyId, 'vkey_new');
    assert.strictEqual(result.budgetLimit, 200.00);
  });
  
  it('should update existing key', async () => {
    const updated = store.updateKey('tktt_live_acme_jane_abc123def456', {
      budgetRemaining: 50.00,
    });
    
    assert.strictEqual(updated, true);
    
    const result = await store.findByToken('tktt_live_acme_jane_abc123def456');
    assert.strictEqual(result?.budgetRemaining, 50.00);
  });
  
  it('should return false when updating non-existent key', async () => {
    const updated = store.updateKey('tktt_live_unknown_key', {
      budgetRemaining: 50.00,
    });
    
    assert.strictEqual(updated, false);
  });
  
  it('should remove key', async () => {
    const removed = store.removeKey('tktt_live_acme_jane_abc123def456');
    assert.strictEqual(removed, true);
    
    const result = await store.findByToken('tktt_live_acme_jane_abc123def456');
    assert.strictEqual(result, null);
  });
  
  it('should list all keys', async () => {
    const keys = store.listKeys();
    assert.ok(keys.length >= 4);
  });
});
