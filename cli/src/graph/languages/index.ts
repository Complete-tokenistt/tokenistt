/** Routes a file to its extractor. Adding a language means adding an entry here and a tested visitor. */
import { posix } from 'node:path';
import { FileBuilder, type Visitor } from '../builder.js';
import { parserFor } from '../parser.js';
import { emptyExtract, type FileExtract } from '../schema.js';
import { extractMarkdown, extractPackageJson, extractTsconfig, extractYaml } from './config.js';
import { visitPython } from './python.js';
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
    } finally {
      parsed.delete();
    }
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
    else if (/^[tj]sconfig(\..+)?\.json$/.test(base)) extractTsconfig(text, x);
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
