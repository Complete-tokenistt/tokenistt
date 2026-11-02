/**
 * Turns per-file extracts into one graph. Names are only linked when they resolve to something real: an
 * unresolved call is counted, never guessed at, so a CALLS edge always points at a symbol that exists.
 */
import { isBuiltin } from 'node:module';
import { posix } from 'node:path';
import {
  columnId, dirId, docId, envId, fileId, moduleId, packageId, serviceId, symbolId, tableId, testId,
  type EdgeType, type FileExtract, type GraphEdge, type GraphNode, type ImportRef, type Resolution, type SymbolDef,
} from './schema.js';

/** Languages where a bare name inside a method means the method on the same class first. */
const IMPLICIT_THIS = new Set(['java', 'csharp', 'cpp', 'c']);
/** Languages where everything in a directory shares one package, with no import needed. */
const DIRECTORY_SCOPED = new Set(['java', 'go', 'php']);

export const isTestPath = (p: string): boolean =>
  /(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.(py|go)$/.test(p);

/** Bytewise, so output is identical on every machine and matches SQLite's ordering. localeCompare is neither. */
const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

export interface LinkStats {
  callsResolved: number;
  callsUnresolved: number;
  importsResolved: number;
  importsExternal: number;
  importsUnresolved: number;
}

export interface LinkResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: LinkStats;
}

interface Workspace {
  dir: string;
  entry?: string;
}

class Linker {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly byPath = new Map<string, FileExtract>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly tsconfigs = new Map<string, FileExtract>();
  /** Per file: local name -> where it was imported from. A Go package spans several files. */
  private readonly bindings = new Map<string, Map<string, { files: string[]; imported: string }>>();
  /** Per file: other files whose top-level names are visible without an import binding. */
  private readonly openScopes = new Map<string, Set<string>>();
  private readonly bySuffix = new Map<string, string[]>();
  private readonly byDir = new Map<string, string[]>();
  private readonly byNamespace = new Map<string, string[]>();
  private readonly goModules: Array<{ name: string; dir: string }> = [];
  private readonly crateRoots = new Set<string>();
  readonly stats: LinkStats = { callsResolved: 0, callsUnresolved: 0, importsResolved: 0, importsExternal: 0, importsUnresolved: 0 };

  constructor(private readonly extracts: FileExtract[], private readonly repoName: string) {
    for (const x of extracts) {
      this.byPath.set(x.path, x);
      if (x.manifest?.name) this.workspaces.set(x.manifest.name, { dir: posix.dirname(x.path), entry: x.manifest.entry });
      if (x.tsconfig) this.tsconfigs.set(posix.dirname(x.path), x);
      if (x.manifest?.ecosystem === 'go' && x.manifest.name) this.goModules.push({ name: x.manifest.name, dir: posix.dirname(x.path) });
      if (x.manifest?.ecosystem === 'rust') this.crateRoots.add(posix.dirname(x.path));
      const base = posix.basename(x.path);
      this.bySuffix.set(base, [...(this.bySuffix.get(base) ?? []), x.path]);
      const dir = posix.dirname(x.path);
      this.byDir.set(dir, [...(this.byDir.get(dir) ?? []), x.path]);
      if (x.namespace) this.byNamespace.set(x.namespace, [...(this.byNamespace.get(x.namespace) ?? []), x.path]);
    }
  }

  private node(n: GraphNode): void {
    if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
  }

  /** Edges dedupe on (source, target, type), keeping the most confident and the earliest line. */
  private edge(source: string, target: string, type: EdgeType, resolution: Resolution, confidence: number, line?: number): void {
    if (source === target && type !== 'CALLS') return;
    const key = `${source}\0${target}\0${type}`;
    const existing = this.edges.get(key);
    if (existing) {
      if (confidence > existing.confidence) {
        existing.confidence = confidence;
        existing.resolution = resolution;
      }
      if (line !== undefined && (existing.line === undefined || line < existing.line)) existing.line = line;
      return;
    }
    this.edges.set(key, { source, target, type, confidence, resolution, ...(line !== undefined ? { line } : {}) });
  }

  // ---- import resolution ----------------------------------------------------------------------------------

  private fileCandidates(base: string): string[] {
    const ext = posix.extname(base);
    const out = [base];
    for (const mapped of JS_TO_TS[ext] ?? []) out.push(base.slice(0, -ext.length) + mapped);
    for (const e of CODE_EXTENSIONS) out.push(base + e);
    for (const e of CODE_EXTENSIONS) out.push(posix.join(base, `index${e}`));
    return out;
  }

  private firstExisting(base: string): string | undefined {
    return this.fileCandidates(posix.normalize(base)).find((c) => this.byPath.has(c));
  }

  private tsconfigFor(from: string): FileExtract | undefined {
    let dir = posix.dirname(from);
    for (;;) {
      const found = this.tsconfigs.get(dir);
      if (found) return found;
      if (dir === '.' || dir === '') return undefined;
      dir = posix.dirname(dir);
    }
  }

  private viaPaths(from: string, spec: string): string | undefined {
    let cfg = this.tsconfigFor(from);
    for (let hops = 0; cfg && hops < 5; hops++) {
      const info = cfg.tsconfig;
      const dir = posix.dirname(cfg.path);
      const baseDir = posix.join(dir, info?.baseUrl ?? '.');
      for (const [pattern, targets] of Object.entries(info?.paths ?? {})) {
        const star = pattern.indexOf('*');
        const matched = star === -1
          ? (spec === pattern ? '' : undefined)
          : (spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) ? spec.slice(star, spec.length - (pattern.length - star - 1)) : undefined);
        if (matched === undefined) continue;
        for (const t of targets) {
          const hit = this.firstExisting(posix.join(baseDir, t.replace('*', matched)));
          if (hit) return hit;
        }
      }
      if (info?.baseUrl) {
        const hit = this.firstExisting(posix.join(baseDir, spec));
        if (hit) return hit;
      }
      if (!info?.extends || !info.extends.startsWith('.')) return undefined;
      const parent = posix.normalize(posix.join(dir, info.extends));
      cfg = this.byPath.get(parent) ?? this.byPath.get(`${parent}.json`);
    }
    return undefined;
  }

  private viaWorkspace(spec: string): string | undefined {
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
    const ws = this.workspaces.get(name);
    if (!ws) return undefined;
    const sub = spec.slice(name.length + 1);
    if (sub) return this.firstExisting(posix.join(ws.dir, sub)) ?? this.firstExisting(posix.join(ws.dir, 'src', sub));
    const entryCandidates: string[] = [];
    if (ws.entry) {
      entryCandidates.push(posix.join(ws.dir, ws.entry));
      // A built entry usually mirrors its source: dist/index.js -> src/index.ts.
      entryCandidates.push(posix.join(ws.dir, ws.entry.replace(/^\.?\/?(dist|build|lib|out)\//, 'src/')));
    }
    entryCandidates.push(posix.join(ws.dir, 'src', 'index'), posix.join(ws.dir, 'index'));
    for (const c of entryCandidates) {
      const hit = this.firstExisting(c);
      if (hit) return hit;
    }
    return undefined;
  }

  /** A file whose path ends in the given segments, dropping leading segments until one matches (PSR-4, Java roots). */
  private bySegments(segments: string[], ext: string, minKept: number): string | undefined {
    for (let drop = 0; segments.length - drop >= minKept; drop++) {
      const suffix = `${segments.slice(drop).join('/')}${ext}`;
      const base = posix.basename(suffix);
      const hits = (this.bySuffix.get(base) ?? []).filter((p) => p === suffix || p.endsWith(`/${suffix}`));
      // An ambiguous match would be a guess.
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return undefined;
    }
    return undefined;
  }

  private filesInDirWithSuffix(segments: string[], language: string): string[] {
    const suffix = segments.join('/');
    const out: string[] = [];
    for (const [dir, files] of this.byDir) {
      if (dir === suffix || dir.endsWith(`/${suffix}`)) out.push(...files.filter((f) => this.byPath.get(f)?.language === language));
    }
    return out;
  }

  private resolveGo(spec: string): { files?: string[]; external?: string } {
    for (const m of this.goModules) {
      if (spec === m.name || spec.startsWith(`${m.name}/`)) {
        const dir = posix.normalize(posix.join(m.dir, spec.slice(m.name.length + 1)));
        const files = (this.byDir.get(dir) ?? []).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
        if (files.length) return { files };
      }
    }
    const parts = spec.split('/');
    return { external: (parts[0] ?? '').includes('.') ? parts.slice(0, 3).join('/') : parts[0] };
  }

  /** Module directory for a Rust file: a.rs owns a/, while mod.rs, lib.rs and main.rs own their own directory. */
  private rustModuleDir(file: string): string {
    const base = posix.basename(file, '.rs');
    const dir = posix.dirname(file);
    return base === 'mod' || base === 'lib' || base === 'main' ? dir : posix.join(dir, base);
  }

  /** The directory holding the crate root: usually src/, but [[bin]] and [lib] may point anywhere. */
  private rustCrateSrc(from: string): string {
    let dir = posix.dirname(from);
    for (;;) {
      if (this.byPath.has(posix.join(dir, 'lib.rs')) || this.byPath.has(posix.join(dir, 'main.rs'))) return dir;
      if (this.crateRoots.has(dir)) return posix.join(dir, 'src');
      if (dir === '.' || dir === '') return 'src';
      dir = posix.dirname(dir);
    }
  }

  private rustModuleFile(base: string): string | undefined {
    return [`${base}.rs`, posix.join(base, 'mod.rs')].map((c) => posix.normalize(c)).find((c) => this.byPath.has(c));
  }

  private resolveRust(from: string, spec: string): { file?: string; external?: string; imported?: string } {
    const parts = spec.split('::');
    let base: string;
    let rest: string[];
    const head = parts[0];
    if (head === 'crate') { base = this.rustCrateSrc(from); rest = parts.slice(1); }
    else if (head === 'self') { base = this.rustModuleDir(from); rest = parts.slice(1); }
    else if (head === 'super') {
      base = this.rustModuleDir(from);
      rest = parts;
      while (rest[0] === 'super') { base = posix.dirname(base); rest = rest.slice(1); }
    } else {
      // Bare paths may name a module declared in this crate; anything else is an external crate.
      base = this.rustCrateSrc(from);
      rest = parts;
      const local = rest.length ? this.rustModuleFile(posix.join(base, rest[0] ?? '')) : undefined;
      if (!local) return { external: head };
    }
    const whole = this.rustModuleFile(posix.join(base, ...rest));
    if (whole) return { file: whole };
    const parent = rest.length > 1 ? this.rustModuleFile(posix.join(base, ...rest.slice(0, -1))) : undefined;
    if (parent) return { file: parent, imported: rest[rest.length - 1] };
    // `use crate::Foo` names an item in the crate root.
    if (rest.length === 1) {
      const root = [posix.join(base, 'lib.rs'), posix.join(base, 'main.rs'), posix.join(base, 'mod.rs')].find((c) => this.byPath.has(c));
      if (root) return { file: root, imported: rest[0] };
    }
    return {};
  }

  private resolveImport(from: string, imp: ImportRef): { file?: string; files?: string[]; external?: string; imported?: string } {
    if (imp.style === 'python') return this.resolvePython(from, imp.source);
    if (imp.style === 'go') return this.resolveGo(imp.source);
    if (imp.style === 'rust') return this.resolveRust(from, imp.source);
    if (imp.style === 'dotted') {
      const segments = imp.source.split('.');
      if (imp.wildcard) {
        const files = this.filesInDirWithSuffix(segments, 'java');
        return files.length ? { files } : { external: segments.slice(0, 2).join('.') };
      }
      const hit = this.bySegments(segments, '.java', 2);
      return hit ? { file: hit } : { external: segments.slice(0, 2).join('.') };
    }
    if (imp.style === 'phpns') {
      const segments = imp.source.split('\\');
      const hit = this.bySegments(segments, '.php', 1);
      return hit ? { file: hit } : { external: segments[0] };
    }
    if (imp.style === 'namespace') {
      const files = this.byNamespace.get(imp.source);
      return files ? { files } : { external: imp.source.split('.')[0] };
    }
    if (imp.style === 'include') {
      if (imp.system) return { external: imp.source };
      const relative = posix.normalize(posix.join(posix.dirname(from), imp.source));
      if (this.byPath.has(relative)) return { file: relative };
      const segments = imp.source.split('/').filter((p) => p !== '.' && p !== '..');
      const last = segments[segments.length - 1] ?? '';
      const stem = last.includes('.') ? last.slice(last.lastIndexOf('.')) : '';
      const hit = this.bySegments([...segments.slice(0, -1), last.slice(0, last.length - stem.length)], stem, 1);
      return hit ? { file: hit } : {};
    }
    const spec = imp.source;
    if (spec.startsWith('.')) return { file: this.firstExisting(posix.join(posix.dirname(from), spec)) };
    if (spec.startsWith('/')) return {};
    const hit = this.viaPaths(from, spec) ?? this.viaWorkspace(spec);
    if (hit) return { file: hit };
    if (isBuiltin(spec)) return { external: spec.startsWith('node:') ? spec : `node:${spec}` };
    const parts = spec.split('/');
    return { external: spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] };
  }

  private resolvePython(from: string, source: string): { file?: string; external?: string } {
    const leading = /^\.+/.exec(source)?.[0].length ?? 0;
    const rest = source.slice(leading).split('.').filter(Boolean).join('/');
    const module = (base: string): string | undefined =>
      [`${base}.py`, posix.join(base, '__init__.py')].map((c) => posix.normalize(c)).find((c) => this.byPath.has(c));
    if (leading > 0) {
      let dir = posix.dirname(from);
      for (let i = 1; i < leading; i++) dir = posix.dirname(dir);
      return { file: module(posix.join(dir, rest || '.')) };
    }
    // Absolute imports resolve from the repo root or from any ancestor of the importer.
    let dir = posix.dirname(from);
    for (;;) {
      const hit = module(posix.join(dir, rest));
      if (hit) return { file: hit };
      if (dir === '.' || dir === '') break;
      dir = posix.dirname(dir);
    }
    return { external: source.split('.')[0] };
  }

  // ---- symbol lookup --------------------------------------------------------------------------------------

  private symbolNodeId(x: FileExtract, s: SymbolDef): string {
    return symbolId(x.path, s.kind, s.qualified);
  }

  private exportedSymbol(file: string, name: string, seen = new Set<string>()): { x: FileExtract; s: SymbolDef } | undefined {
    const key = `${file}\0${name}`;
    if (seen.has(key) || seen.size > 16) return undefined;
    seen.add(key);
    const x = this.byPath.get(file);
    if (!x) return undefined;
    const lookup = name === 'default' ? x.defaultExport : name;
    if (lookup) {
      const direct = x.symbols.find((s) => !s.parent && s.qualified === lookup);
      if (direct) return { x, s: direct };
    }
    for (const re of x.reExports) {
      const target = re.source ? this.resolveImport(file, { source: re.source, line: 0, bindings: [], style: 'path' }).file : file;
      if (!target) continue;
      if (re.names.length === 0) {
        const found = this.exportedSymbol(target, name, seen);
        if (found) return found;
        continue;
      }
      const named = re.names.find((n) => n.exported === name);
      if (named) {
        const local = target === file ? this.bindings.get(file)?.get(named.imported) : undefined;
        if (local) return this.fromFiles(local.files, local.imported, seen);
        const found = this.exportedSymbol(target, named.imported, seen);
        if (found) return found;
      }
    }
    return undefined;
  }

  private fromFiles(files: string[], name: string, seen = new Set<string>()): { x: FileExtract; s: SymbolDef } | undefined {
    for (const f of files) {
      const found = this.exportedSymbol(f, name, seen);
      if (found) return found;
    }
    return undefined;
  }

  /** A top-level name visible through an open scope, as long as exactly one file provides it. */
  private inOpenScope(x: FileExtract, name: string): { x: FileExtract; s: SymbolDef } | undefined {
    let found: { x: FileExtract; s: SymbolDef } | undefined;
    for (const f of this.openScopes.get(x.path) ?? []) {
      const other = this.byPath.get(f);
      const s = other?.symbols.find((d) => !d.parent && d.name === name);
      if (!other || !s) continue;
      if (found) return undefined;
      found = { x: other, s };
    }
    return found;
  }

  /** The target of a bare or dotted name used in `x`, with how sure we are. */
  private resolveName(x: FileExtract, name: string, object: string | undefined, fromQualified: string | undefined): { id: string; resolution: Resolution; confidence: number } | undefined {
    if (object === 'this') {
      const cls = fromQualified?.split('.').slice(0, -1).join('.');
      const m = cls ? x.symbols.find((s) => s.qualified === `${cls}.${name}`) : undefined;
      return m ? { id: this.symbolNodeId(x, m), resolution: 'local', confidence: 0.9 } : undefined;
    }
    const bindings = this.bindings.get(x.path);
    if (object) {
      const b = bindings?.get(object);
      if (b) {
        if (b.imported === '*') {
          const found = this.fromFiles(b.files, name);
          return found ? { id: this.symbolNodeId(found.x, found.s), resolution: 'import', confidence: 0.85 } : undefined;
        }
        const owner = this.fromFiles(b.files, b.imported);
        const m = owner?.x.symbols.find((s) => s.qualified === `${owner.s.qualified}.${name}`);
        return owner && m ? { id: this.symbolNodeId(owner.x, m), resolution: 'import', confidence: 0.8 } : undefined;
      }
      const owner = x.symbols.find((s) => !s.parent && s.name === object);
      const m = owner ? x.symbols.find((s) => s.qualified === `${owner.qualified}.${name}`) : undefined;
      if (m) return { id: this.symbolNodeId(x, m), resolution: 'local', confidence: 0.8 };
      const scoped = this.inOpenScope(x, object);
      const sm = scoped?.x.symbols.find((s) => s.qualified === `${scoped.s.qualified}.${name}`);
      return scoped && sm ? { id: this.symbolNodeId(scoped.x, sm), resolution: 'import', confidence: 0.75 } : undefined;
    }
    if (x.language && IMPLICIT_THIS.has(x.language) && fromQualified) {
      const cls = fromQualified.split('.').slice(0, -1).join('.');
      const m = cls ? x.symbols.find((s) => s.qualified === `${cls}.${name}`) : undefined;
      if (m) return { id: this.symbolNodeId(x, m), resolution: 'local', confidence: 0.85 };
    }
    const local = x.symbols.find((s) => s.name === name && !s.parent) ?? x.symbols.find((s) => s.name === name);
    if (local) return { id: this.symbolNodeId(x, local), resolution: 'local', confidence: local.parent ? 0.6 : 0.95 };
    const b = bindings?.get(name);
    if (b) {
      const found = this.fromFiles(b.files, b.imported);
      if (found) return { id: this.symbolNodeId(found.x, found.s), resolution: 'import', confidence: 0.9 };
    }
    const scoped = this.inOpenScope(x, name);
    if (scoped) {
      // Namespaces and includes bring in whole files, so this is the first real evidence of a dependency.
      if (scoped.x.path !== x.path) this.edge(fileId(x.path), fileId(scoped.x.path), 'IMPORTS', 'import', 0.75);
      return { id: this.symbolNodeId(scoped.x, scoped.s), resolution: 'import', confidence: 0.75 };
    }
    return undefined;
  }

  // ---- phases ---------------------------------------------------------------------------------------------

  private structure(): void {
    const rootId = dirId('.');
    this.node({ id: rootId, type: 'repository', name: this.repoName, path: '.' });
    for (const x of this.extracts) {
      let child = fileId(x.path);
      this.node({
        id: child, type: 'file', name: posix.basename(x.path), path: x.path, ...(x.language ? { language: x.language } : {}), parent: x.path.includes('/') ? dirId(posix.dirname(x.path)) : rootId,
        metadata: { sha: x.sha, bytes: x.bytes, ...(x.parseErrors ? { parseErrors: true } : {}), ...(x.skipped ? { skipped: x.skipped } : {}) },
      });
      let dir = posix.dirname(x.path);
      while (dir !== '.' && dir !== '') {
        const id = dirId(dir);
        this.node({ id, type: 'directory', name: posix.basename(dir), path: dir, parent: posix.dirname(dir) === '.' ? rootId : dirId(posix.dirname(dir)) });
        this.edge(id, child, 'CONTAINS', 'exact', 1);
        child = id;
        dir = posix.dirname(dir);
      }
      this.edge(rootId, child, 'CONTAINS', 'exact', 1);
    }
  }

  private symbols(x: FileExtract): void {
    const file = fileId(x.path);
    for (const s of x.symbols) {
      const id = this.symbolNodeId(x, s);
      const owner = s.parent ? x.symbols.find((p) => p.qualified === s.parent) : undefined;
      const parent = owner ? this.symbolNodeId(x, owner) : file;
      this.node({ id, type: s.kind, name: s.name, path: x.path, ...(x.language ? { language: x.language } : {}), parent, startLine: s.startLine, endLine: s.endLine, metadata: { qualified: s.qualified, exported: s.exported } });
      this.edge(parent, id, 'CONTAINS', 'exact', 1, s.startLine);
      if (s.exported) this.edge(file, id, 'EXPORTS', 'exact', 1, s.startLine);
    }
  }

  private imports(x: FileExtract): void {
    const file = fileId(x.path);
    const bindings = new Map<string, { files: string[]; imported: string }>();
    this.bindings.set(x.path, bindings);
    const scope = new Set<string>();
    this.openScopes.set(x.path, scope);
    if (x.language && DIRECTORY_SCOPED.has(x.language)) {
      for (const f of this.byDir.get(posix.dirname(x.path)) ?? []) if (f !== x.path && this.byPath.get(f)?.language === x.language) scope.add(f);
    }
    if (x.namespace) for (const f of this.byNamespace.get(x.namespace) ?? []) if (f !== x.path) scope.add(f);
    const test = isTestPath(x.path);
    if (test) {
      this.node({ id: testId(x.path), type: 'test', name: posix.basename(x.path), path: x.path, parent: file });
      // Go tests sit beside the code and need no import to reach it.
      const subject = x.path.replace(/_test\.go$/, '.go');
      if (subject !== x.path && this.byPath.has(subject)) this.edge(testId(x.path), fileId(subject), 'TESTS', 'exact', 0.9);
    }
    for (const imp of x.imports) {
      const resolved = this.resolveImport(x.path, imp);
      const { external } = resolved;
      const targets = resolved.files ?? (resolved.file ? [resolved.file] : []);
      if (targets.length) {
        this.stats.importsResolved++;
        // A namespace import names a scope, not a dependency on every file in it; see resolveName.
        const opens = imp.wildcard || imp.style === 'namespace' || imp.style === 'include';
        if (imp.style !== 'namespace') {
          for (const target of targets) {
            this.edge(file, fileId(target), 'IMPORTS', 'resolved', 1, imp.line);
            if (test && !isTestPath(target)) this.edge(testId(x.path), fileId(target), 'TESTS', 'import', 0.8, imp.line);
          }
        }
        if (opens) for (const target of targets) if (target !== x.path) scope.add(target);
        // In Rust, using a whole module binds it as a namespace; an item keeps its own name.
        const wholeModule = imp.style === 'rust' && resolved.imported === undefined;
        for (const b of imp.bindings) bindings.set(b.local, { files: targets, imported: wholeModule ? '*' : b.imported });
      } else if (external) {
        this.stats.importsExternal++;
        const id = packageId(external);
        this.node({ id, type: 'package', name: external, metadata: { external: true } });
        this.edge(file, id, 'IMPORTS', 'exact', 1, imp.line);
      } else {
        this.stats.importsUnresolved++;
      }
    }
  }

  private references(x: FileExtract): void {
    const file = fileId(x.path);
    const fromId = (qualified: string | undefined): string => {
      const s = qualified ? x.symbols.find((d) => d.qualified === qualified) : undefined;
      return s ? this.symbolNodeId(x, s) : file;
    };
    for (const c of x.calls) {
      const target = this.resolveName(x, c.callee, c.object, c.from);
      if (!target) {
        this.stats.callsUnresolved++;
        continue;
      }
      this.stats.callsResolved++;
      this.edge(fromId(c.from), target.id, 'CALLS', target.resolution, target.confidence, c.line);
    }
    for (const h of x.heritage) {
      const target = this.resolveName(x, h.name, undefined, undefined);
      if (target) this.edge(fromId(h.from), target.id, h.kind, target.resolution, target.confidence, h.line);
    }
    for (const e of x.env) {
      this.node({ id: envId(e.name), type: 'env_var', name: e.name });
      this.edge(fromId(e.from), envId(e.name), 'USES', 'exact', 1, e.line);
    }
  }

  private database(x: FileExtract): void {
    const file = fileId(x.path);
    const table = (name: string, view?: boolean, line?: number, endLine?: number) => {
      const id = tableId(name);
      const existing = this.nodes.get(id);
      // A forward reference creates the node first; the CREATE statement fills in where it lives.
      if (existing && line !== undefined && existing.path === undefined) {
        existing.path = x.path;
        existing.startLine = line;
        if (endLine !== undefined) existing.endLine = endLine;
        if (view) existing.metadata = { view: true };
      }
      this.node({ id, type: 'table', name, ...(line !== undefined ? { path: x.path, startLine: line } : {}), ...(endLine !== undefined ? { endLine } : {}), ...(view ? { metadata: { view: true } } : {}) });
      return id;
    };
    const columns = (t: string, cols: Array<{ name: string; line: number }>) => {
      for (const c of cols) {
        const id = columnId(t, c.name);
        this.node({ id, type: 'column', name: c.name, path: x.path, parent: tableId(t), startLine: c.line });
        this.edge(tableId(t), id, 'CONTAINS', 'exact', 1, c.line);
      }
    };
    for (const t of x.tables) {
      const id = table(t.name, t.view, t.line, t.endLine);
      this.edge(file, id, 'CONTAINS', 'exact', 1, t.line);
      columns(t.name, t.columns);
      for (const r of t.references) this.edge(id, table(r.table), 'DEPENDS_ON', 'exact', 1, r.line);
      for (const read of t.readsFrom) this.edge(id, table(read), 'READS_FROM', 'exact', 1, t.line);
    }
    for (const a of x.altered) {
      const id = table(a.name);
      this.edge(file, id, 'MODIFIES', 'exact', 1, a.line);
      columns(a.name, a.columns);
      for (const r of a.references) this.edge(id, table(r.table), 'DEPENDS_ON', 'exact', 1, r.line);
    }
  }

  private config(x: FileExtract): void {
    const file = fileId(x.path);
    if (x.manifest) {
      const dir = posix.dirname(x.path);
      const id = moduleId(dir);
      this.node({ id, type: 'module', name: x.manifest.name ?? (dir === '.' ? this.repoName : posix.basename(dir)), path: dir, metadata: { ecosystem: x.manifest.ecosystem } });
      this.edge(id, file, 'CONTAINS', 'exact', 1);
      for (const d of x.manifest.dependencies) {
        const ws = this.workspaces.get(d.name);
        if (ws) {
          this.edge(id, moduleId(ws.dir), 'DEPENDS_ON', 'exact', 1);
        } else {
          this.node({ id: packageId(d.name), type: 'package', name: d.name, metadata: { external: true } });
          this.edge(id, packageId(d.name), 'DEPENDS_ON', 'exact', 1);
        }
      }
    }
    for (const s of x.services) {
      const id = serviceId(x.path, s.name);
      this.node({ id, type: 'service', name: s.name, path: x.path, startLine: s.line, ...(s.image ? { metadata: { image: s.image } } : {}) });
      this.edge(file, id, 'CONTAINS', 'exact', 1, s.line);
      for (const d of s.dependsOn) this.edge(id, serviceId(x.path, d), 'DEPENDS_ON', 'exact', 1, s.line);
      for (const e of s.env) {
        this.node({ id: envId(e), type: 'env_var', name: e });
        this.edge(id, envId(e), 'USES', 'exact', 1, s.line);
      }
    }
    if (x.language === 'markdown') {
      const id = docId(x.path);
      this.node({ id, type: 'documentation', name: posix.basename(x.path), path: x.path, parent: file });
      for (const link of x.docLinks) if (this.byPath.has(link)) this.edge(fileId(link), id, 'DOCUMENTED_BY', 'exact', 1);
    }
  }

  /** A service depending on something defined elsewhere would leave a dangling edge; drop those. */
  private pruneDangling(): void {
    for (const [key, e] of this.edges) if (!this.nodes.has(e.source) || !this.nodes.has(e.target)) this.edges.delete(key);
  }

  run(): LinkResult {
    this.structure();
    for (const x of this.extracts) this.symbols(x);
    // Bindings must exist for every file before any name is resolved, since re-exports cross files.
    for (const x of this.extracts) this.imports(x);
    for (const x of this.extracts) {
      this.references(x);
      this.database(x);
      this.config(x);
    }
    this.pruneDangling();
    return {
      nodes: [...this.nodes.values()].sort((a, b) => byBytes(a.id, b.id)),
      edges: [...this.edges.values()].sort((a, b) => byBytes(a.source, b.source) || byBytes(a.target, b.target) || byBytes(a.type, b.type)),
      stats: this.stats,
    };
  }
}

export function linkGraph(extracts: FileExtract[], repoName: string): LinkResult {
  return new Linker([...extracts].sort((a, b) => byBytes(a.path, b.path)), repoName).run();
}
