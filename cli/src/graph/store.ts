/** Graph persistence in SQLite (the queryable copy) and export to JSON (the portable copy). */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../store/db.js';
import { projectDir } from '../store/project.js';
import { EXTRACTOR_VERSION, GRAPH_SCHEMA_VERSION, type FileExtract, type GraphDocument, type GraphEdge, type GraphNode, type RepositoryRef } from './schema.js';

export interface GraphMetadata {
  schemaVersion: string;
  extractorVersion: number;
  repository: RepositoryRef;
  generatedAt: string;
  durationMs: number;
  mode: 'full' | 'incremental' | 'imported';
  files: { total: number; parsed: number; reused: number; skipped: number; parseErrors: number };
  nodes: Record<string, number>;
  edges: Record<string, number>;
  links: Record<string, number>;
  languages: Record<string, number>;
}

function transaction(db: Database, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function loadExtracts(db: Database): Map<string, FileExtract> {
  const rows = db.prepare('SELECT path, extractor, extract FROM file_extracts').all() as Array<{ path: string; extractor: number; extract: string }>;
  const out = new Map<string, FileExtract>();
  for (const r of rows) if (r.extractor === EXTRACTOR_VERSION) out.set(r.path, JSON.parse(r.extract) as FileExtract);
  return out;
}

export function saveGraph(db: Database, extracts: FileExtract[], nodes: GraphNode[], edges: GraphEdge[]): void {
  transaction(db, () => {
    db.exec('DELETE FROM file_extracts; DELETE FROM graph_edges; DELETE FROM graph_nodes; DELETE FROM graph_fts;');
    const insertExtract = db.prepare('INSERT INTO file_extracts (path, sha, extractor, extract) VALUES (?, ?, ?, ?)');
    for (const x of extracts) insertExtract.run(x.path, x.sha, EXTRACTOR_VERSION, JSON.stringify(x));
    const insertNode = db.prepare('INSERT INTO graph_nodes (id, type, name, path, language, parent, start_line, end_line, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertFts = db.prepare('INSERT INTO graph_fts (id, name, path) VALUES (?, ?, ?)');
    for (const n of nodes) {
      insertNode.run(n.id, n.type, n.name, n.path ?? null, n.language ?? null, n.parent ?? null, n.startLine ?? null, n.endLine ?? null, n.metadata ? JSON.stringify(n.metadata) : null);
      insertFts.run(n.id, n.name, n.path ?? '');
    }
    const insertEdge = db.prepare('INSERT INTO graph_edges (source, target, type, confidence, resolution, line) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of edges) insertEdge.run(e.source, e.target, e.type, e.confidence, e.resolution, e.line ?? null);
  });
}

/** Replaces the graph with an imported one. The per-file cache is dropped because it described a different tree. */
export function saveImportedGraph(db: Database, doc: GraphDocument): void {
  saveGraph(db, [], doc.nodes, doc.edges);
}

interface NodeRow {
  id: string; type: GraphNode['type']; name: string; path: string | null; language: string | null; parent: string | null; start_line: number | null; end_line: number | null; metadata: string | null;
}

const toNode = (r: NodeRow): GraphNode => ({
  id: r.id, type: r.type, name: r.name,
  ...(r.path !== null ? { path: r.path } : {}), ...(r.language !== null ? { language: r.language } : {}), ...(r.parent !== null ? { parent: r.parent } : {}),
  ...(r.start_line !== null ? { startLine: r.start_line } : {}), ...(r.end_line !== null ? { endLine: r.end_line } : {}),
  ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) as Record<string, unknown> } : {}),
});

export function readNodes(db: Database): GraphNode[] {
  return (db.prepare('SELECT * FROM graph_nodes ORDER BY id').all() as unknown as NodeRow[]).map(toNode);
}

export function readEdges(db: Database): GraphEdge[] {
  const rows = db.prepare('SELECT source, target, type, confidence, resolution, line FROM graph_edges ORDER BY source, target, type').all() as unknown as Array<GraphEdge & { line: number | null }>;
  return rows.map(({ line, ...e }) => ({ ...e, ...(line !== null ? { line } : {}) }));
}

export function graphCounts(nodes: GraphNode[], edges: GraphEdge[]): { nodes: Record<string, number>; edges: Record<string, number> } {
  const tally = <T>(items: T[], key: (t: T) => string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort());
  };
  return { nodes: tally(nodes, (n) => n.type), edges: tally(edges, (e) => e.type) };
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/** graph.json holds no timestamps, so an unchanged repository produces an identical file. */
export function writeGraphFiles(root: string, doc: GraphDocument, metadata: GraphMetadata): void {
  const dir = join(projectDir(root), 'graph');
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'graph.json'), doc);
  writeJson(join(dir, 'metadata.json'), metadata);
}

export function readMetadata(db: Database): GraphMetadata | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'graph_metadata'").get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as GraphMetadata) : undefined;
}

export function saveMetadata(db: Database, metadata: GraphMetadata): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('graph_metadata', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(metadata));
}

/** Split export for tools that want nodes and edges separately. */
export function exportJson(root: string, doc: GraphDocument, out?: string): string[] {
  const dir = out ?? join(projectDir(root), 'exports');
  mkdirSync(dir, { recursive: true });
  const files = [join(dir, 'graph.json'), join(dir, 'nodes.json'), join(dir, 'edges.json')];
  writeJson(files[0] ?? '', doc);
  writeJson(files[1] ?? '', doc.nodes);
  writeJson(files[2] ?? '', doc.edges);
  return files;
}

export const graphDocument = (repository: RepositoryRef, nodes: GraphNode[], edges: GraphEdge[]): GraphDocument => ({ schemaVersion: GRAPH_SCHEMA_VERSION, repository, nodes, edges });
