/**
 * Builds the graph: list files, read what is allowed, extract each one, link, store. A file whose content hash
 * is unchanged reuses its cached extract, so the only cost of a re-run is hashing plus relinking.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles } from '../project/git.js';
import type { Database } from '../store/db.js';
import type { Project } from '../store/project.js';
import { createExcluder, hasBinaryExtension, looksBinary } from './exclude.js';
import { extractFile } from './languages/index.js';
import { linkGraph } from './linker.js';
import { EXTRACTOR_VERSION, GRAPH_SCHEMA_VERSION, emptyExtract, type FileExtract, type GraphDocument, type RepositoryRef } from './schema.js';
import { graphCounts, graphDocument, loadExtracts, saveGraph, saveMetadata, writeGraphFiles, type GraphMetadata } from './store.js';

export interface IndexProgress {
  phase(label: string): void;
  count(done: number, total?: number): void;
}

export interface IndexOptions {
  /** Ignore cached extracts and parse everything again. */
  full?: boolean;
  now?: () => Date;
  progress?: IndexProgress;
}

export interface IndexResult {
  doc: GraphDocument;
  metadata: GraphMetadata;
}

export async function indexProject(project: Project, db: Database, opts: IndexOptions = {}): Promise<IndexResult> {
  const started = Date.now();
  const { repo, config } = project;
  const repository: RepositoryRef = { id: config.projectId, name: config.name, branch: repo.branch ?? null, commit: repo.commit ?? null };
  const progress = opts.progress;

  progress?.phase('Listing files');
  const excluded = createExcluder(config.index.exclude);
  const paths = listFiles(repo.root).filter((p) => !excluded(p));
  progress?.count(paths.length);

  const cached = opts.full ? new Map<string, FileExtract>() : loadExtracts(db);
  const files = { total: paths.length, parsed: 0, reused: 0, skipped: 0, parseErrors: 0 };
  const extracts: FileExtract[] = [];

  progress?.phase('Analyzing files');
  let done = 0;
  for (const path of paths) {
    progress?.count(++done, paths.length);
    const abs = join(repo.root, path);
    let bytes: number;
    try {
      const st = lstatSync(abs);
      // Symlinks could point outside the repository, and a deleted-but-tracked file has nothing to read.
      if (!st.isFile()) { files.skipped++; continue; }
      bytes = st.size;
    } catch {
      files.skipped++;
      continue;
    }

    if (hasBinaryExtension(path) || bytes > config.index.maxFileBytes) {
      const x = emptyExtract(path, '', bytes);
      x.skipped = bytes > config.index.maxFileBytes ? 'too large' : 'binary';
      extracts.push(x);
      files.skipped++;
      continue;
    }

    const content = readFileSync(abs);
    if (looksBinary(content)) {
      const x = emptyExtract(path, '', bytes);
      x.skipped = 'binary';
      extracts.push(x);
      files.skipped++;
      continue;
    }

    const sha = createHash('sha256').update(content).digest('hex');
    const hit = cached.get(path);
    if (hit?.sha === sha) {
      extracts.push(hit);
      files.reused++;
    } else {
      extracts.push(await extractFile(path, content.toString('utf8'), sha, bytes));
      files.parsed++;
    }
  }
  files.parseErrors = extracts.filter((x) => x.parseErrors).length;

  progress?.phase('Linking relationships');
  const { nodes, edges, stats } = linkGraph(extracts, config.name);
  progress?.count(edges.length);

  progress?.phase('Saving graph');
  const counts = graphCounts(nodes, edges);
  const languages: Record<string, number> = {};
  for (const x of extracts) if (x.language) languages[x.language] = (languages[x.language] ?? 0) + 1;
  const metadata: GraphMetadata = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    repository,
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    durationMs: Date.now() - started,
    mode: files.reused > 0 ? 'incremental' : 'full',
    files,
    nodes: counts.nodes,
    edges: counts.edges,
    links: { ...stats },
    languages: Object.fromEntries(Object.entries(languages).sort()),
  };
  const doc = graphDocument(repository, nodes, edges);
  saveGraph(db, extracts, nodes, edges);
  saveMetadata(db, metadata);
  writeGraphFiles(repo.root, doc, metadata);
  return { doc, metadata };
}
