import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// QUEUE_FILE is read when the module loads, so point it at a temp file first.
const dir = mkdtempSync(join(tmpdir(), 'tokenistt-queue-'));
const file = join(dir, 'tx_queue.jsonl');
process.env.TX_QUEUE_FILE = file;

const base = {
  requestId: 'req-1', organizationId: '1', workspaceId: '10', virtualKeyId: '100', actor: 'a@b.co',
  provider: 'openai', model: 'gpt-4o', endpoint: '/v1/chat/completions', costCenter: 'eng', projectTag: null,
  costUsd: '0.010000', inputCostUsd: '0.005000', outputCostUsd: '0.005000',
  promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheCreationTokens: 0, cacheReadTokens: 0,
  status: 'success', errorCode: null, durationMs: 120, metadata: {}, queuedAt: new Date().toISOString(), attempts: 0,
};

describe('durable queue replay', () => {
  let mod: typeof import('../db/durableQueue.js');
  before(async () => { mod = await import('../db/durableQueue.js'); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('replays attribution and the usage columns that were captured before the outage', async () => {
    mod.enqueueTransaction({
      ...base, requestId: 'req-new',
      reasoningTokens: 7, costStatus: 'COST_UNAVAILABLE', tokensEstimated: true,
      teamId: '5', projectId: '6', environment: 'prod', repo: 'org/repo', ticket: 'ABC-1',
      sprint: 's1', feature: 'search', customer: 'acme', employee: 'sarah',
    });
    const calls: Array<{ text: string; values: any[] }> = [];
    await mod.drainQueue({ query: async (text: string, values: any[]) => { calls.push({ text, values }); return { rowCount: 1 }; } });

    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /team_id, project_id, environment, repo, ticket, sprint, feature, customer, employee/);
    assert.match(calls[0].text, /reasoning_tokens, cost_status, tokens_estimated/);
    const v = calls[0].values;
    assert.deepEqual(v.slice(23), [7, 'COST_UNAVAILABLE', true, '5', '6', 'prod', 'org/repo', 'ABC-1', 's1', 'search', 'acme', 'sarah']);
    // Fully drained: nothing left to retry.
    assert.equal(!existsSync(file) || readFileSync(file, 'utf-8').trim() === '', true);
  });

  it('still replays entries queued by an older version (no new fields)', async () => {
    writeFileSync(file, JSON.stringify({ ...base, requestId: 'req-old' }) + '\n');
    const calls: Array<{ values: any[] }> = [];
    await mod.drainQueue({ query: async (_t: string, values: any[]) => { calls.push({ values }); return { rowCount: 1 }; } });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values.slice(23), [0, 'ok', false, null, null, null, null, null, null, null, null, null]);
  });

  it('keeps an entry for retry when the database is still down', async () => {
    writeFileSync(file, JSON.stringify({ ...base, requestId: 'req-retry' }) + '\n');
    await mod.drainQueue({ query: async () => { throw new Error('connection refused'); } });
    const left = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(left.length, 1);
    assert.equal(left[0].requestId, 'req-retry');
    assert.equal(left[0].attempts, 1);
  });
});
