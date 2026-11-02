/**
 * Finds what is relevant to a question by combining graph names, memory, session history and, if a provider is
 * configured, embeddings. Each result lists which signals found it. Embeddings are optional and off by default.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CliError } from '../core/errors.js';
import { configDir } from '../config/store.js';
import { GraphIndex } from '../graph/query.js';
import { searchMemories } from '../memory/store.js';
import type { Database } from '../store/db.js';

const UserConfig = z.object({
  embeddings: z.object({ baseUrl: z.string().url(), model: z.string().min(1), apiKeyEnv: z.string().optional() }).optional(),
});
export type EmbeddingConfig = NonNullable<z.infer<typeof UserConfig>['embeddings']>;

/**
 * Read from the user's own config, never the repository's: an endpoint set by a cloned repo could receive symbol
 * names from your code.
 */
export function readEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig | undefined {
  const file = join(configDir(env), 'intelligence.json');
  if (!existsSync(file)) return undefined;
  try {
    return UserConfig.parse(JSON.parse(readFileSync(file, 'utf8'))).embeddings;
  } catch {
    throw new CliError(`${file} is invalid.`, 1, 'Expected: { "embeddings": { "baseUrl": "http://localhost:11434/v1", "model": "nomic-embed-text" } }');
  }
}

export type Embed = (texts: string[]) => Promise<number[][]>;

/** Any OpenAI-compatible /embeddings endpoint, including a local Ollama. */
export function httpEmbedder(cfg: EmbeddingConfig, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Embed {
  return async (texts) => {
    const key = cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined;
    const res = await fetchImpl(`${cfg.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new CliError(`The embedding endpoint returned HTTP ${res.status}.`);
    const body = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding ?? []);
    if (rows.length !== texts.length || rows.some((r) => r.length === 0)) throw new CliError('The embedding endpoint returned an unexpected response.');
    return rows;
  };
}

/** Names and paths only: this is what leaves the machine if the endpoint is remote, so source code never does. */
const embedText = (n: { name: string; type: string; path?: string }): string => `${n.type} ${n.name}${n.path ? ` in ${n.path}` : ''}`;
const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

const EMBEDDABLE = new Set(['file', 'function', 'method', 'class', 'interface', 'component', 'endpoint', 'table']);

export async function updateEmbeddings(db: Database, index: GraphIndex, embed: Embed, model: string, batchSize = 64): Promise<{ embedded: number; reused: number }> {
  const existing = new Map((db.prepare('SELECT node_id, hash FROM embeddings WHERE model = ?').all(model) as Array<{ node_id: string; hash: string }>).map((r) => [r.node_id, r.hash]));
  const todo: Array<{ id: string; text: string; h: string }> = [];
  let reused = 0;
  for (const n of index.nodes.values()) {
    if (!EMBEDDABLE.has(n.type)) continue;
    const text = embedText(n);
    const h = hash(text);
    if (existing.get(n.id) === h) reused++;
    else todo.push({ id: n.id, text, h });
  }
  const put = db.prepare('INSERT INTO embeddings (node_id, model, hash, vector) VALUES (?, ?, ?, ?) ON CONFLICT (node_id, model) DO UPDATE SET hash = excluded.hash, vector = excluded.vector');
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const vectors = await embed(batch.map((b) => b.text));
    batch.forEach((b, j) => { put.run(b.id, model, b.h, new Uint8Array(new Float32Array(vectors[j] as number[]).buffer)); });
  }
  return { embedded: todo.length, reused };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) {
    const [p, q] = [a[i] ?? 0, b[i] ?? 0];
    dot += p * q;
    x += p * p;
    y += q * q;
  }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}

function semanticMatches(db: Database, query: number[], model: string, limit: number): Array<{ id: string; score: number }> {
  const q = new Float32Array(query);
  const rows = db.prepare('SELECT node_id, vector FROM embeddings WHERE model = ?').all(model) as Array<{ node_id: string; vector: Uint8Array }>;
  return rows.map((r) => ({ id: r.node_id, score: cosine(q, new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4)) }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface SearchHit {
  kind: 'code' | 'memory' | 'session';
  id: string;
  title: string;
  detail?: string;
  /** Which signals found this, so a result can be judged. */
  signals: string[];
  score: number;
}

export interface SearchOptions {
  limit?: number;
  embed?: Embed;
  model?: string;
}

const STOP = new Set(['the', 'and', 'for', 'how', 'does', 'what', 'where', 'with', 'this', 'that', 'from', 'are', 'our']);

/** Rank fusion: position in each list counts, not raw scores, which are not comparable between signals. */
export async function search(db: Database, index: GraphIndex | undefined, query: string, opts: SearchOptions = {}): Promise<{ hits: SearchHit[]; semantic: boolean }> {
  const limit = opts.limit ?? 15;
  const hits = new Map<string, SearchHit>();
  const add = (key: string, make: () => Omit<SearchHit, 'signals' | 'score'>, signal: string, rank: number): void => {
    const hit = hits.get(key) ?? { ...make(), signals: [], score: 0 };
    if (!hit.signals.includes(signal)) hit.signals.push(signal);
    hit.score += 1 / (10 + rank);
    hits.set(key, hit);
  };
  const code = (id: string, signal: string, rank: number): void => {
    const n = index?.nodes.get(id);
    if (n) add(`code:${id}`, () => ({ kind: 'code', id, title: (n.metadata?.qualified as string | undefined) ?? n.name, detail: `${n.type}${n.path ? ` in ${n.path}${n.startLine ? `:${n.startLine}` : ''}` : ''}` }), signal, rank);
  };

  if (index) {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])].filter((t) => !STOP.has(t));
    for (const term of terms) index.search(term, 20).forEach((v, i) => code(v.id, 'name', i));
    // Things directly connected to strong name matches are worth seeing too.
    const strong = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 5).map((h) => h.id);
    for (const id of strong) index.relations(id, 8).incoming.forEach((r, i) => code(r.id, 'graph', i + 5));
  }
  searchMemories(db, query, 20).forEach((m, i) => add(`memory:${m.id}`, () => ({ kind: 'memory', id: m.id, title: m.content.slice(0, 160), detail: `${m.category.toLowerCase().replaceAll('_', ' ')}, from ${m.source_kind}: ${m.source_ref.slice(0, 60)}${m.status === 'stale' ? ', stale' : ''}` }), 'memory', i));

  const sessionRows = index ? [...hits.values()].filter((h) => h.kind === 'code').slice(0, 10).flatMap((h) => {
    const path = index.nodes.get(h.id)?.path;
    return path ? (db.prepare(`SELECT DISTINCT s.key, s.agent, s.session_id FROM agent_events e JOIN agent_sessions s ON s.key = e.session_key WHERE e.path = ? AND e.type IN ('FILE_CREATED', 'FILE_MODIFIED') LIMIT 3`).all(path) as Array<{ key: string; agent: string; session_id: string }>).map((s) => ({ ...s, path })) : [];
  }) : [];
  sessionRows.forEach((s, i) => add(`session:${s.key}`, () => ({ kind: 'session', id: s.key, title: `${s.agent} session ${s.session_id.slice(0, 8)}`, detail: `changed ${s.path}` }), 'session', i + 5));

  let semantic = false;
  if (opts.embed && opts.model && index) {
    const [vector] = await opts.embed([query]);
    if (vector) {
      semanticMatches(db, vector, opts.model, 20).forEach((m, i) => code(m.id, 'semantic', i));
      semantic = true;
    }
  }
  return { hits: [...hits.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit), semantic };
}

