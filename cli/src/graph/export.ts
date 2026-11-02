/**
 * Reads a graph.json written by any version of the CLI. The file may have come from someone else, so it is
 * validated as untrusted data, and older schema versions are brought forward one step at a time.
 */
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { CliError } from '../core/errors.js';
import { GRAPH_SCHEMA_VERSION, type GraphDocument } from './schema.js';

const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

/** Each entry upgrades a document from the version named by its key to the next one. None exist yet. */
export const GRAPH_MIGRATIONS: Record<string, (doc: Record<string, unknown>) => Record<string, unknown>> = {};

const Node = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string(),
  path: z.string().optional(),
  language: z.string().optional(),
  parent: z.string().optional(),
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const Edge = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1),
  confidence: z.number().min(0).max(1),
  resolution: z.string().min(1),
  line: z.number().int().optional(),
});

const Document = z.object({
  schemaVersion: z.string(),
  repository: z.object({ id: z.string(), name: z.string(), branch: z.string().nullable(), commit: z.string().nullable() }),
  nodes: z.array(Node),
  edges: z.array(Edge),
});

const versionParts = (v: string): number[] => v.split('.').map(Number);

function isNewer(a: string, b: string): boolean {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

export function migrateGraphDocument(raw: Record<string, unknown>, migrations = GRAPH_MIGRATIONS, target = GRAPH_SCHEMA_VERSION): Record<string, unknown> {
  let doc = raw;
  for (let guard = 0; guard < 100; guard++) {
    const version = doc.schemaVersion;
    if (typeof version !== 'string') throw new CliError('This graph file has no schemaVersion.', 2, 'Is it a graph.json written by `tokenistt map`?');
    if (version === target) return doc;
    if (isNewer(version, target)) throw new CliError(`This graph file is schema ${version}, newer than this CLI understands (${target}).`, 1, 'Upgrade tokenistt.');
    const step = migrations[version];
    if (!step) throw new CliError(`No migration from graph schema ${version} to ${target}.`, 1, 'Re-create the graph with `tokenistt map`.');
    doc = step(doc);
  }
  throw new CliError('Graph schema migration did not finish.');
}

export function parseGraphDocument(text: string): GraphDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError('This graph file is not valid JSON.', 2);
  }
  if (!raw || typeof raw !== 'object') throw new CliError('This graph file is not a graph document.', 2);
  const migrated = migrateGraphDocument(raw as Record<string, unknown>);
  const parsed = Document.safeParse(migrated);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError(`This graph file is invalid at ${issue?.path.join('.') || 'the top level'}: ${issue?.message}.`, 2);
  }
  const doc = parsed.data as GraphDocument;
  const ids = new Set(doc.nodes.map((n) => n.id));
  if (ids.size !== doc.nodes.length) throw new CliError('This graph file has duplicate node ids.', 2);
  for (const e of doc.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) throw new CliError(`This graph file has an edge to a missing node: ${e.source} -> ${e.target}.`, 2);
  }
  return doc;
}

export function readGraphFile(file: string): GraphDocument {
  let bytes: number;
  try {
    bytes = statSync(file).size;
  } catch {
    throw new CliError(`Cannot read ${file}.`, 2);
  }
  if (bytes > MAX_IMPORT_BYTES) throw new CliError(`${file} is larger than the ${MAX_IMPORT_BYTES / 1024 / 1024} MB import limit.`, 2);
  return parseGraphDocument(readFileSync(file, 'utf8'));
}
