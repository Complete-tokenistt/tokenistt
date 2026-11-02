/** Manifests, compose files, tsconfig and Markdown links. Values that could hold secrets are never kept. */
import { posix } from 'node:path';
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import type { ComposeService, FileExtract } from '../schema.js';

/** JSON with comments and trailing commas, as tsconfig allows. Strings are left alone. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function packageEntry(pkg: Record<string, unknown>): string | undefined {
  const exp = pkg.exports;
  const fromExports = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return fromExports(o['.']) ?? fromExports(o.import) ?? fromExports(o.types) ?? fromExports(o.default) ?? fromExports(o.require);
    }
    return undefined;
  };
  const candidates = [fromExports(exp), pkg.module, pkg.main, pkg.types];
  return candidates.find((c): c is string => typeof c === 'string');
}

export function extractPackageJson(text: string, x: FileExtract): void {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const deps = (key: string, dev: boolean) => Object.keys((pkg[key] as Record<string, string>) ?? {}).map((name) => ({ name, dev }));
    x.manifest = {
      ...(typeof pkg.name === 'string' ? { name: pkg.name } : {}),
      ...(packageEntry(pkg) ? { entry: packageEntry(pkg) } : {}),
      dependencies: [...deps('dependencies', false), ...deps('devDependencies', true), ...deps('peerDependencies', false)],
      ecosystem: 'npm',
    };
  } catch {
    x.parseErrors = true;
  }
}

export function extractTsconfig(text: string, x: FileExtract): void {
  try {
    const cfg = parseJsonc(text) as { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: Record<string, string[]> } };
    x.tsconfig = {
      paths: cfg.compilerOptions?.paths ?? {},
      ...(typeof cfg.compilerOptions?.baseUrl === 'string' ? { baseUrl: cfg.compilerOptions.baseUrl } : {}),
      ...(typeof cfg.extends === 'string' ? { extends: cfg.extends } : {}),
    };
  } catch {
    x.parseErrors = true;
  }
}

/** Parsed for every YAML file; only docker-compose shaped documents produce anything. */
export function extractYaml(text: string, x: FileExtract): void {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  if (doc.errors.length) {
    x.parseErrors = true;
    return;
  }
  const services = doc.get('services', true);
  if (!isMap(services)) return;
  const out: ComposeService[] = [];
  for (const item of services.items) {
    if (!isScalar(item.key) || !isMap(item.value)) continue;
    const def = item.value;
    const svc: ComposeService = { name: String(item.key.value), line: counter.linePos(item.key.range?.[0] ?? 0).line, dependsOn: [], env: [] };
    const image = def.get('image');
    if (typeof image === 'string') svc.image = image;
    const dependsOn = def.get('depends_on', true);
    if (isSeq(dependsOn)) for (const d of dependsOn.items) if (isScalar(d)) svc.dependsOn.push(String(d.value));
    if (isMap(dependsOn)) for (const d of dependsOn.items) if (isScalar(d.key)) svc.dependsOn.push(String(d.key.value));
    const env = def.get('environment', true);
    if (isMap(env)) for (const e of env.items) if (isScalar(e.key)) svc.env.push(String(e.key.value));
    if (isSeq(env)) for (const e of env.items) if (isScalar(e)) svc.env.push(String(e.value).split('=')[0] ?? '');
    svc.env = svc.env.filter(Boolean);
    out.push(svc);
  }
  x.services = out;
}

/** Relative links only. External URLs and anchors say nothing about this repository's structure. */
export function extractMarkdown(text: string, x: FileExtract): void {
  const links = new Set<string>();
  const re = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const target = (m[1] ?? '').split('#')[0] ?? '';
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(x.path), target));
    if (!resolved.startsWith('..')) links.add(resolved.replace(/\/$/, ''));
  }
  x.docLinks = [...links];
}
