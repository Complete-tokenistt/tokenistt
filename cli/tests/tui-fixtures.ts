import type { SessionSummary } from '../src/agents/sessions.js';
import type { DashboardData } from '../src/tui/data.js';

export const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  key: 'claude-code:abcdefgh', agent: 'claude-code', id: 'abcdefgh1234', branch: 'main', state: 'active', startedAt: 't', endedAt: null, lastEventAt: 't', durationMs: 754000, endReason: null, task: null, models: ['m1'],
  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 18420, requests: 1 }, cost: { costUsd: null, source: 'unknown' },
  counts: { tasks: 1, filesRead: 0, filesCreated: 0, filesModified: 1, filesDeleted: 0, commands: 0, tools: 0, errors: 2, testsPassed: 1, testsFailed: 0, testsUnknown: 0 },
  files: { read: [], created: [], modified: ['src/a.ts'], deleted: [] }, commands: [], ...over,
});

export const usage = (key: string, total: number, cost: number | null): DashboardData['usage']['day'][number] => ({
  key, label: key, requests: 3, sessions: 1, input: total / 2, output: total / 4, cacheRead: total / 4, cacheCreation: 0, total,
  cost: cost === null ? { costUsd: null, source: 'unknown', knownUsd: 0, unpricedTokens: total, unpricedModels: ['m1'] } : { costUsd: cost, source: 'catalog_estimate', knownUsd: cost, unpricedTokens: 0, unpricedModels: [] },
});

export const data = (over: Partial<DashboardData> = {}): DashboardData => ({
  project: { name: 'demo', id: 'repo_x', root: '/r', branch: 'main', commit: 'abc1234', subject: 'first', privacy: 'name', capturePrompts: false, syncEnabled: false },
  graph: { schemaVersion: '1.0', extractorVersion: 1, repository: { id: 'r', name: 'demo', branch: 'main', commit: 'c' }, generatedAt: '2026-11-02', durationMs: 1, mode: 'full', files: { total: 7, parsed: 7, reused: 0, skipped: 0, parseErrors: 0 }, nodes: { file: 7, function: 3 }, edges: { CALLS: 5 }, links: {}, languages: { typescript: 7 } },
  largest: [{ name: 'src', type: 'directory', nodes: 12 }], mostUsed: [{ name: 'query', type: 'function', dependents: 4, path: 'src/db.ts' }],
  agents: [{ id: 'claude-code', name: 'Claude Code', installed: true, connected: true, state: 'active', verification: 'live' }, { id: 'codex', name: 'OpenAI Codex', installed: false, connected: false, state: 'not connected', verification: 'documented' }],
  sessions: [session(), session({ key: 'k2', id: 'zzzz9999', tokens: null, state: 'ended' })],
  costs: [{ agent: 'Claude Code', sessions: 2, tokens: 18420, unreportedSessions: 1, cost: { costUsd: null, source: 'unknown', knownUsd: 0.5, unpricedTokens: 900, unpricedModels: ['m1 cache reads'] } }, { agent: 'OpenAI Codex', sessions: 0, tokens: 0, unreportedSessions: 0, cost: { costUsd: null, source: 'unknown' } }],
  usage: {
    day: [usage('2026-11-05', 1200, 0.42), usage('2026-11-04', 800, null)], week: [usage('2026-11-02', 2000, null)], model: [usage('m1', 2000, null)], session: [usage('claude-code abcdefgh', 2000, null)],
  },
  memory: { total: 3, active: 2, stale: 1, superseded: 0, retired: 0, byCategory: { ARCHITECTURAL_DECISIONS: 1 }, bySource: {}, lastUpdated: '2026-11-02' },
  memories: [{ id: 'm', content: 'Use Postgres', status: 'active' } as never, { id: 'n', content: 'Old fact', status: 'stale' } as never],
  gateway: { state: 'not configured', url: null },
  ...over,
});

