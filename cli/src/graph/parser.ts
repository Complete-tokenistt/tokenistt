/**
 * Tree-sitter via WebAssembly, so installing the CLI compiles nothing. Grammars load on first use.
 *
 * web-tree-sitter is pinned to 0.25: the prebuilt grammars in tree-sitter-wasms are ABI 13/14, and 0.27 fails to
 * load them. The YAML grammar needs a C++ runtime that the wasm build lacks, so YAML uses the `yaml` library.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Language, Parser } from 'web-tree-sitter';

export type { Node as SyntaxNode, Tree } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const grammarDir = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

let ready: Promise<void> | undefined;
const parsers = new Map<string, Promise<Parser>>();

export function parserFor(grammar: string): Promise<Parser> {
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = (async () => {
      ready ??= Parser.init();
      await ready;
      const language = await Language.load(join(grammarDir, `tree-sitter-${grammar}.wasm`));
      const p = new Parser();
      p.setLanguage(language);
      return p;
    })();
    parsers.set(grammar, parser);
  }
  return parser;
}
