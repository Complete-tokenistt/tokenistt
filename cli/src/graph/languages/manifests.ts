/**
 * Dependency manifests outside npm. These are line scans of well-known sections, not full TOML or XML parsers:
 * enough to name a module and list its dependencies, which is all the graph uses them for.
 */
import type { FileExtract, ManifestInfo } from '../schema.js';

const manifest = (ecosystem: ManifestInfo['ecosystem'], name: string | undefined, dependencies: ManifestInfo['dependencies']): ManifestInfo => ({ ...(name ? { name } : {}), dependencies, ecosystem });

export function extractGoMod(text: string, x: FileExtract): void {
  const name = /^module\s+(\S+)/m.exec(text)?.[1];
  const deps: ManifestInfo['dependencies'] = [];
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line.startsWith('require (')) { inBlock = true; continue; }
    if (inBlock && line === ')') { inBlock = false; continue; }
    const single = /^require\s+(\S+)\s+\S+/.exec(line);
    const dep = single?.[1] ?? (inBlock ? line.split(/\s+/)[0] : undefined);
    if (dep) deps.push({ name: dep, dev: false });
  }
  x.manifest = manifest('go', name, deps);
}

/** Section-aware walk over TOML keys: tables of the form [dependencies] and [dependencies.x]. */
function tomlSections(text: string): Array<{ section: string; key: string; value: string }> {
  const out: Array<{ section: string; key: string; value: string }> = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header) { section = header[1]?.trim() ?? ''; continue; }
    const kv = /^([A-Za-z0-9_.\-"]+)\s*=\s*(.*)$/.exec(line);
    if (kv) out.push({ section, key: (kv[1] ?? '').replace(/"/g, ''), value: kv[2] ?? '' });
  }
  return out;
}

export function extractCargoToml(text: string, x: FileExtract): void {
  const entries = tomlSections(text);
  const name = entries.find((e) => e.section === 'package' && e.key === 'name')?.value.replace(/["']/g, '');
  const deps: ManifestInfo['dependencies'] = [];
  for (const e of entries) {
    if (e.section === 'dependencies' || e.section === 'dev-dependencies' || e.section === 'build-dependencies') deps.push({ name: e.key, dev: e.section !== 'dependencies' });
  }
  for (const m of text.matchAll(/^\[(dependencies|dev-dependencies)\.([^\]]+)\]/gm)) deps.push({ name: m[2] ?? '', dev: m[1] !== 'dependencies' });
  x.manifest = manifest('rust', name, deps);
}

/** PEP 621 `dependencies = [...]` and Poetry's `[tool.poetry.dependencies]`. */
export function extractPyproject(text: string, x: FileExtract): void {
  const entries = tomlSections(text);
  const name = entries.find((e) => (e.section === 'project' || e.section === 'tool.poetry') && e.key === 'name')?.value.replace(/["']/g, '');
  const deps: ManifestInfo['dependencies'] = [];
  const list = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text)?.[1];
  for (const m of list?.matchAll(/["']([A-Za-z0-9_.-]+)/g) ?? []) if (m[1]) deps.push({ name: m[1], dev: false });
  for (const e of entries) if (e.section === 'tool.poetry.dependencies' && e.key !== 'python') deps.push({ name: e.key, dev: false });
  x.manifest = manifest('python', name, deps);
}

export function extractPomXml(text: string, x: FileExtract): void {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  // The project's own artifactId is the first one outside <parent>.
  const name = /<artifactId>([^<]+)<\/artifactId>/.exec(withoutComments.replace(/<parent>[\s\S]*?<\/parent>/, ''))?.[1]?.trim();
  const deps: ManifestInfo['dependencies'] = [];
  for (const m of withoutComments.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = m[1] ?? '';
    const group = /<groupId>([^<]+)<\/groupId>/.exec(body)?.[1]?.trim();
    const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(body)?.[1]?.trim();
    if (artifact) deps.push({ name: group ? `${group}:${artifact}` : artifact, dev: /<scope>\s*test\s*<\/scope>/.test(body) });
  }
  x.manifest = manifest('java', name, deps);
}

export function extractComposerJson(text: string, x: FileExtract): void {
  try {
    const c = JSON.parse(text) as { name?: unknown; require?: Record<string, string>; 'require-dev'?: Record<string, string> };
    const deps = (o: Record<string, string> | undefined, dev: boolean) => Object.keys(o ?? {}).filter((n) => n !== 'php' && !n.startsWith('ext-')).map((name) => ({ name, dev }));
    x.manifest = manifest('php', typeof c.name === 'string' ? c.name : undefined, [...deps(c.require, false), ...deps(c['require-dev'], true)]);
  } catch {
    x.parseErrors = true;
  }
}

export function extractCsproj(text: string, x: FileExtract): void {
  const deps: ManifestInfo['dependencies'] = [];
  for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) deps.push({ name: m[1] ?? '', dev: false });
  x.manifest = manifest('dotnet', x.path.split('/').pop()?.replace(/\.csproj$/, ''), deps);
}
