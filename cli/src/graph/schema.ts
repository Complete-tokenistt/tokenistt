/**
 * The portable graph format. Bump GRAPH_SCHEMA_VERSION on any incompatible change and add a migration in
 * export.ts, so an older graph.json can still be imported.
 */
export const GRAPH_SCHEMA_VERSION = '1.0';
/** Bump when extraction output changes, so cached per-file results are thrown away. */
export const EXTRACTOR_VERSION = 2;

export type NodeType =
  | 'repository' | 'directory' | 'file' | 'function' | 'method' | 'class' | 'interface' | 'type' | 'variable'
  | 'component' | 'endpoint' | 'table' | 'column' | 'module' | 'package' | 'service' | 'env_var' | 'test'
  | 'session' | 'change' | 'decision' | 'issue' | 'documentation';

export type EdgeType =
  | 'CONTAINS' | 'IMPORTS' | 'EXPORTS' | 'CALLS' | 'EXTENDS' | 'IMPLEMENTS' | 'USES' | 'DEPENDS_ON' | 'CONNECTS_TO'
  | 'READS_FROM' | 'WRITES_TO' | 'TESTS' | 'MODIFIES' | 'CREATED_IN' | 'DISCUSSED_IN' | 'DOCUMENTED_BY' | 'DECIDED_IN';

/**
 * How an edge was established. Nothing here comes from a type checker, so anything other than `exact` is an
 * inference, and `confidence` says how far to trust it.
 *   exact     stated directly in the file (containment, a config entry, a DDL reference)
 *   resolved  an import path that was resolved to a real file
 *   local     a name matched a symbol in the same file
 *   import    a name matched through an import binding
 *   framework derived by a framework analyzer
 */
export type Resolution = 'exact' | 'resolved' | 'local' | 'import' | 'framework';

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  path?: string;
  language?: string;
  parent?: string;
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  confidence: number;
  resolution: Resolution;
  line?: number;
}

export interface RepositoryRef {
  id: string;
  name: string;
  branch: string | null;
  commit: string | null;
}

export interface GraphDocument {
  schemaVersion: string;
  repository: RepositoryRef;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const fileId = (path: string): string => `file:${path}`;
export const dirId = (path: string): string => `dir:${path}`;
export const symbolId = (path: string, kind: string, qualified: string): string => `sym:${path}#${kind}:${qualified}`;
export const packageId = (name: string): string => `pkg:${name}`;
export const moduleId = (path: string): string => `module:${path}`;
export const envId = (name: string): string => `env:${name}`;
export const tableId = (name: string): string => `table:${name}`;
export const columnId = (table: string, column: string): string => `col:${table}.${column}`;
export const testId = (path: string): string => `test:${path}`;
export const docId = (path: string): string => `doc:${path}`;
export const serviceId = (file: string, name: string): string => `svc:${file}#${name}`;
export const endpointId = (file: string, method: string, path: string): string => `api:${file}#${method} ${path}`;

export type SymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'variable';

export interface SymbolDef {
  kind: SymbolKind;
  name: string;
  /** Includes the enclosing class, e.g. Service.create. */
  qualified: string;
  parent?: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface ImportRef {
  source: string;
  line: number;
  /** Names bound by this import: `*` is a namespace, `default` the default export. */
  bindings: Array<{ imported: string; local: string }>;
  /** How `source` is resolved to files. See Linker.resolveImport. */
  style: 'path' | 'python' | 'dotted' | 'go' | 'rust' | 'phpns' | 'namespace' | 'include';
  typeOnly?: boolean;
  /** Brings every name from the source into scope, e.g. Java's `import a.b.*`. */
  wildcard?: boolean;
  /** `#include <x>`: searched on the system path, not in the repository. */
  system?: boolean;
}

export interface ReExport {
  source: string;
  /** Empty means `export * from`. */
  names: Array<{ imported: string; exported: string }>;
}

export interface CallRef {
  /** Qualified name of the enclosing symbol; absent at file level. */
  from?: string;
  callee: string;
  /** `this`, or the identifier before the dot. */
  object?: string;
  line: number;
}

export interface HeritageRef {
  from: string;
  name: string;
  kind: 'EXTENDS' | 'IMPLEMENTS';
  line: number;
}

export interface EnvRef {
  from?: string;
  name: string;
  line: number;
}

export interface TableDef {
  name: string;
  line: number;
  endLine: number;
  /** A view rather than a base table. */
  view?: boolean;
  /** Declared through an ORM rather than DDL. */
  orm?: 'drizzle' | 'prisma' | 'django' | 'jpa';
  /** The code name for this table, for linking usages: a Drizzle variable or an ORM model. */
  variable?: string;
  model?: string;
  columns: Array<{ name: string; line: number }>;
  references: Array<{ table: string; column?: string; line: number }>;
  readsFrom: string[];
}

export interface EndpointDef {
  method: string;
  path: string;
  framework: string;
  line: number;
  /** The router variable, used to apply mount prefixes. */
  router?: string;
  /** `qualified` names a symbol in this file; otherwise it is resolved like a call. */
  handler?: { name: string; object?: string; qualified?: boolean };
  /** Calls made inside an inline handler, so a route links to what it does. */
  calls?: Array<{ callee: string; object?: string; line: number }>;
}

/** app.use('/v1', router) */
export interface MountDef {
  prefix: string;
  router: string;
  on: string;
  line: number;
}

export interface TableAccess {
  /** Exactly one of these names the table. */
  table?: string;
  variable?: string;
  model?: string;
  access: 'read' | 'write';
  via: 'sql' | 'drizzle' | 'prisma' | 'supabase' | 'django';
  from?: string;
  line: number;
}

/** A dependency that is neither a call nor an import: JSX usage, constructor injection. */
export interface UseRef {
  from?: string;
  name: string;
  line: number;
}

export interface AlteredTable {
  name: string;
  line: number;
  columns: Array<{ name: string; line: number }>;
  references: Array<{ table: string; column?: string; line: number }>;
}

export interface ManifestInfo {
  /** Workspace, package or Go module name. */
  name?: string;
  entry?: string;
  dependencies: Array<{ name: string; dev: boolean }>;
  ecosystem: 'npm' | 'python' | 'go' | 'rust' | 'java' | 'php' | 'dotnet' | 'cmake';
}

export interface ComposeService {
  name: string;
  line: number;
  image?: string;
  dependsOn: string[];
  /** Variable names only. Values are never read into the graph. */
  env: string[];
}

export interface TsconfigInfo {
  baseUrl?: string;
  paths: Record<string, string[]>;
  extends?: string;
}

/** Everything extracted from one file, independent of any other file, so it can be cached by content hash. */
export interface FileExtract {
  path: string;
  language?: string;
  sha: string;
  bytes: number;
  parseErrors: boolean;
  /** The file was listed but deliberately not read, e.g. over the size limit. */
  skipped?: string;
  symbols: SymbolDef[];
  imports: ImportRef[];
  reExports: ReExport[];
  defaultExport?: string;
  /** Declared namespace or package (Java, C#, PHP). */
  namespace?: string;
  calls: CallRef[];
  heritage: HeritageRef[];
  env: EnvRef[];
  tables: TableDef[];
  altered: AlteredTable[];
  manifest?: ManifestInfo;
  tsconfig?: TsconfigInfo;
  services: ComposeService[];
  docLinks: string[];
  endpoints: EndpointDef[];
  mounts: MountDef[];
  routerPrefixes: Array<{ router: string; prefix: string }>;
  tableAccess: TableAccess[];
  uses: UseRef[];
  /** Top-level symbols that are React components. */
  components: string[];
}

export function emptyExtract(path: string, sha: string, bytes: number, language?: string): FileExtract {
  return { path, language, sha, bytes, parseErrors: false, symbols: [], imports: [], reExports: [], calls: [], heritage: [], env: [], tables: [], altered: [], services: [], docLinks: [], endpoints: [], mounts: [], routerPrefixes: [], tableAccess: [], uses: [], components: [] };
}
