/** Routes a file to its extractor. Adding a language means adding an entry here and a tested visitor. */
import { posix } from 'node:path';
import { FileBuilder, type Visitor } from '../builder.js';
import { analyzeJava } from '../frameworks/java.js';
import { analyzeJavaScript } from '../frameworks/javascript.js';
import { extractPrisma } from '../frameworks/prisma.js';
import { analyzePython } from '../frameworks/python.js';
import { parserFor, type SyntaxNode } from '../parser.js';
import { emptyExtract, type FileExtract } from '../schema.js';
import { extractMarkdown, extractPackageJson, extractTsconfig, extractYaml } from './config.js';
import { extractCargoToml, extractComposerJson, extractCsproj, extractGoMod, extractPomXml, extractPyproject } from './manifests.js';
import { visitC } from './c.js';
import { visitCsharp } from './csharp.js';
import { visitGo } from './go.js';
import { visitJava } from './java.js';
import { visitPhp } from './php.js';
import { visitPython } from './python.js';
import { visitRust } from './rust.js';
import { extractSql } from './sql.js';
import { visitTypeScript } from './typescript.js';

interface TreeLanguage {
  language: string;
  grammar: string;
  visit: Visitor;
}

const TREE_LANGUAGES: Record<string, TreeLanguage> = {
  '.ts': { language: 'typescript', grammar: 'typescript', visit: visitTypeScript },
  '.mts': { language: 'typescript', grammar: 'typescript', visit: visitTypeScript },
  '.cts': { language: 'typescript', grammar: 'typescript', visit: visitTypeScript },
  '.tsx': { language: 'typescript', grammar: 'tsx', visit: visitTypeScript },
  '.js': { language: 'javascript', grammar: 'javascript', visit: visitTypeScript },
  '.jsx': { language: 'javascript', grammar: 'javascript', visit: visitTypeScript },
  '.mjs': { language: 'javascript', grammar: 'javascript', visit: visitTypeScript },
  '.cjs': { language: 'javascript', grammar: 'javascript', visit: visitTypeScript },
  '.py': { language: 'python', grammar: 'python', visit: visitPython },
  '.java': { language: 'java', grammar: 'java', visit: visitJava },
  '.go': { language: 'go', grammar: 'go', visit: visitGo },
  '.rs': { language: 'rust', grammar: 'rust', visit: visitRust },
  '.php': { language: 'php', grammar: 'php', visit: visitPhp },
  '.cs': { language: 'csharp', grammar: 'c_sharp', visit: visitCsharp },
  '.c': { language: 'c', grammar: 'c', visit: visitC },
  // A header may be either language, and the C++ grammar reads both.
  '.h': { language: 'c', grammar: 'cpp', visit: visitC },
  '.cc': { language: 'cpp', grammar: 'cpp', visit: visitC },
  '.cpp': { language: 'cpp', grammar: 'cpp', visit: visitC },
  '.cxx': { language: 'cpp', grammar: 'cpp', visit: visitC },
  '.hpp': { language: 'cpp', grammar: 'cpp', visit: visitC },
  '.hh': { language: 'cpp', grammar: 'cpp', visit: visitC },
};

/** Framework analyzers run after a language's structural pass, so they can see its symbols. */
const ANALYZERS: Record<string, (root: SyntaxNode, x: FileExtract) => void> = {
  typescript: analyzeJavaScript,
  javascript: analyzeJavaScript,
  python: analyzePython,
  java: analyzeJava,
};

const MANIFESTS: Record<string, (text: string, x: FileExtract) => void> = {
  'go.mod': extractGoMod,
  'Cargo.toml': extractCargoToml,
  'pom.xml': extractPomXml,
  'pyproject.toml': extractPyproject,
};

export async function extractFile(path: string, text: string, sha: string, bytes: number): Promise<FileExtract> {
  const ext = posix.extname(path).toLowerCase();
  const base = posix.basename(path);

  const tree = TREE_LANGUAGES[ext];
  if (tree) {
    const x = emptyExtract(path, sha, bytes, tree.language);
    const parser = await parserFor(tree.grammar);
    const parsed = parser.parse(text);
    if (!parsed) {
      x.parseErrors = true;
      return x;
    }
    try {
      x.parseErrors = parsed.rootNode.hasError;
      new FileBuilder(x).walk(parsed.rootNode, tree.visit);
      ANALYZERS[tree.language]?.(parsed.rootNode, x);
    } finally {
      parsed.delete();
    }
    return x;
  }

  if (ext === '.prisma') {
    const x = emptyExtract(path, sha, bytes, 'prisma');
    extractPrisma(text, x);
    return x;
  }
  if (ext === '.sql') {
    const x = emptyExtract(path, sha, bytes, 'sql');
    extractSql(text, x);
    return x;
  }
  if (ext === '.json') {
    const x = emptyExtract(path, sha, bytes, 'json');
    if (base === 'package.json') extractPackageJson(text, x);
    else if (base === 'composer.json') extractComposerJson(text, x);
    else if (/^[tj]sconfig(\..+)?\.json$/.test(base)) extractTsconfig(text, x);
    return x;
  }
  const manifest = MANIFESTS[base] ?? (ext === '.csproj' ? extractCsproj : undefined);
  if (manifest) {
    const x = emptyExtract(path, sha, bytes);
    manifest(text, x);
    return x;
  }
  if (ext === '.yaml' || ext === '.yml') {
    const x = emptyExtract(path, sha, bytes, 'yaml');
    extractYaml(text, x);
    return x;
  }
  if (ext === '.md' || ext === '.mdx') {
    const x = emptyExtract(path, sha, bytes, 'markdown');
    extractMarkdown(text, x);
    return x;
  }
  return emptyExtract(path, sha, bytes);
}
