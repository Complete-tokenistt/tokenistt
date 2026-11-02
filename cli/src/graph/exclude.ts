/**
 * What the indexer refuses to read, on top of .gitignore. Tracked files are not automatically safe, so secrets
 * and generated output are excluded even when someone committed them.
 */
import picomatch from 'picomatch';

export const DEFAULT_EXCLUDES = [
  // secrets and credentials
  '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore', '**/*.kdbx',
  '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/.npmrc', '**/.pypirc', '**/.netrc', '**/.aws/**', '**/.ssh/**',
  '**/credentials', '**/credentials.*', '**/secrets', '**/secrets.*', '**/*secret*.json', '**/*secret*.yaml', '**/*secret*.yml',
  '**/*.tfstate', '**/*.tfstate.*', '**/*.tfvars',
  // dependencies and build output
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/target/**', '**/vendor/**',
  '**/__pycache__/**', '**/.venv/**', '**/venv/**', '**/coverage/**', '**/.turbo/**', '**/.git/**', '.tokenistt/**',
  // generated
  '**/*.min.js', '**/*.min.css', '**/*.map', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/poetry.lock', '**/Cargo.lock', '**/composer.lock', '**/go.sum',
];

const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|a|o|obj|wasm|node|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|webm|wav|sqlite3?|db|bin|dat|pyc|psd|ai|sketch|fig)$/i;

export function createExcluder(extra: string[] = []): (path: string) => boolean {
  return picomatch([...DEFAULT_EXCLUDES, ...extra], { dot: true });
}

export const hasBinaryExtension = (path: string): boolean => BINARY_EXTENSIONS.test(path);

/** A NUL byte in the first 8 KB is the same heuristic git uses. */
export function looksBinary(content: Buffer): boolean {
  return content.subarray(0, 8192).includes(0);
}
