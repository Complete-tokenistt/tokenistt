import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setMockPool } from '../db/pool.js';
import { checkPolicies } from '../db/policies.js';
import { AuthContext } from '../db/auth.js';

describe('Governance Policy Engine', () => {
  let mockQueryResults: any[] = [];
  let databaseUrlBackup: string | undefined;

  beforeEach(() => {
    databaseUrlBackup = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
    
    // Set mock pool
    setMockPool({
      query: async (sql: string, params?: any[]) => {
        return { rows: mockQueryResults };
      }
    });
  });

  afterEach(() => {
    process.env.DATABASE_URL = databaseUrlBackup;
    setMockPool(null);
  });

  it('should allow request when no policies are configured', async () => {
    mockQueryResults = [];
    const auth: AuthContext = {
      actor: 'bob@acme.io',
      costCenter: 'engineering',
      organizationId: 1n,
      workspaceId: 10n,
      virtualKeyId: 100n,
      virtualKeyPublicId: 'tktt_live_abc',
      budgetCapUsd: null,
      budgetUsedUsd: 0,
      budgetPeriod: 'none',
      allowedProviders: [],
      realApiKey: null
    };

    const request = {
      model: 'gpt-4o',
      messages: [{ role: 'user' as const, content: 'Hello' }]
    };

    const result = await checkPolicies(auth, request);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.modifiedRequest, undefined);
  });

  it('should block GPT-4 for the Intern Team', async () => {
    mockQueryResults = [{
      id: '1',
      public_id: '11111111-1111-1111-1111-111111111111',
      name: 'Block GPT-4 for Interns',
      description: 'Block GPT-4 for interns',
      is_enabled: true,
      conditions: { cost_center: 'interns', model: 'gpt-4' },
      actions: { effect: 'block', message: 'Forbidden model access' }
    }];

    const authIntern: AuthContext = {
      actor: 'intern@acme.io',
      costCenter: 'interns',
      organizationId: 1n,
      workspaceId: 10n,
      virtualKeyId: 100n,
      virtualKeyPublicId: 'tktt_live_abc',
      budgetCapUsd: null,
      budgetUsedUsd: 0,
      budgetPeriod: 'none',
      allowedProviders: [],
      realApiKey: null
    };

    const authEng: AuthContext = {
      actor: 'senior@acme.io',
      costCenter: 'engineering',
      organizationId: 1n,
      workspaceId: 10n,
      virtualKeyId: 101n,
      virtualKeyPublicId: 'tktt_live_def',
      budgetCapUsd: null,
      budgetUsedUsd: 0,
      budgetPeriod: 'none',
      allowedProviders: [],
      realApiKey: null
    };

    const request = {
      model: 'openai:gpt-4o',
      messages: [{ role: 'user' as const, content: 'Hello' }]
    };

    // Intern should be blocked
    const result1 = await checkPolicies(authIntern, request);
    assert.strictEqual(result1.allowed, false);
    assert.strictEqual(result1.reason, 'Forbidden model access');

    // Engineer should be allowed
    const result2 = await checkPolicies(authEng, request);
    assert.strictEqual(result2.allowed, true);
  });

  it('should force Claude 3 Haiku for summarization tasks using GPT-4', async () => {
    mockQueryResults = [{
      id: '2',
      public_id: '22222222-2222-2222-2222-222222222222',
      name: 'Force Haiku for Summarization',
      description: 'Force Haiku',
      is_enabled: true,
      conditions: { prompt_keyword: 'summarize', model: 'gpt-4' },
      actions: { effect: 'force_model', model: 'claude-3-haiku' }
    }];

    const auth: AuthContext = {
      actor: 'user@acme.io',
      costCenter: 'marketing',
      organizationId: 1n,
      workspaceId: 10n,
      virtualKeyId: 100n,
      virtualKeyPublicId: 'tktt_live_abc',
      budgetCapUsd: null,
      budgetUsedUsd: 0,
      budgetPeriod: 'none',
      allowedProviders: [],
      realApiKey: null
    };

    const reqSummarize = {
      model: 'openai:gpt-4o',
      messages: [{ role: 'user' as const, content: 'Please summarize this text: some details...' }]
    };

    const reqGeneral = {
      model: 'openai:gpt-4o',
      messages: [{ role: 'user' as const, content: 'Tell me a joke.' }]
    };

    // Summarize request should have its model modified to claude-3-haiku
    const result1 = await checkPolicies(auth, reqSummarize);
    assert.strictEqual(result1.allowed, true);
    assert.ok(result1.modifiedRequest !== undefined);
    assert.strictEqual(result1.modifiedRequest.model, 'claude-3-haiku');

    // General request should be unchanged
    const result2 = await checkPolicies(auth, reqGeneral);
    assert.strictEqual(result2.allowed, true);
    assert.strictEqual(result2.modifiedRequest, undefined);
  });
});
