/** Read-only git queries. Paths come back repo-relative with forward slashes on every platform. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024;

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_BUFFER }).trimEnd();
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args) || undefined;
  } catch {
    return undefined;
  }
}

export interface RepoInfo {
  root: string;
  name: string;
  branch?: string;
  commit?: string;
  commitSubject?: string;
  /** Host and path only: credentials embedded in the URL are never kept. */
  remote?: string;
}

/** Reduces any remote form to host/path, dropping credentials, the scheme and a trailing .git. */
export function normalizeRemote(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (scp && !/^[a-z+]+:\/\//i.test(trimmed)) {
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  } else {
    try {
      const u = new URL(trimmed);
      host = u.host;
      path = u.pathname;
    } catch {
      return undefined;
    }
  }
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return host && clean ? `${host.toLowerCase()}/${clean}` : undefined;
}

export function repoInfo(cwd: string): RepoInfo | undefined {
  const top = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return undefined;
  const root = resolve(top);
  const remoteUrl = tryGit(root, ['config', '--get', 'remote.origin.url']);
  const remote = remoteUrl ? normalizeRemote(remoteUrl) : undefined;
  return {
    root,
    name: remote?.split('/').pop() ?? root.split(/[\\/]/).pop() ?? 'repository',
    branch: tryGit(root, ['symbolic-ref', '--short', 'HEAD']),
    commit: tryGit(root, ['rev-parse', 'HEAD']),
    commitSubject: tryGit(root, ['log', '-1', '--format=%s']),
    remote,
  };
}

/** Tracked and untracked files, honouring .gitignore. */
export function listFiles(root: string): string[] {
  const out = git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
  return [...new Set(out.split('\0').filter(Boolean))];
}

/** Stable across clones when a remote or history exists; falls back to the path for an empty local repo. */
export function projectIdFor(info: RepoInfo): string {
  const seed = info.remote ?? tryGit(info.root, ['rev-list', '--max-parents=0', 'HEAD'])?.split('\n').sort()[0] ?? info.root;
  return `repo_${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}
