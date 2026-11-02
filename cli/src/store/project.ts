/**
 * The per-repository .tokenistt/ directory.
 *
 * config.json is committed, so it is untrusted input from whoever wrote the repo: it holds no secrets, and
 * nothing in it may cause code to run or data to leave for a new destination. Plugins and embedding
 * endpoints belong in the user-level config instead.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CliError, UsageError } from '../core/errors.js';
import { projectIdFor, repoInfo, type RepoInfo } from '../project/git.js';

export const PROJECT_DIR = '.tokenistt';
const SUBDIRS = ['database', 'graph', 'memory', 'sessions', 'cache', 'logs', 'exports'];

const GITIGNORE = `# Local data: indexes, session events and caches stay on this machine.
*
!.gitignore
!config.json
`;

export const ProjectConfig = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().regex(/^repo_[0-9a-f]{16}$/),
  name: z.string().min(1),
  createdAt: z.string(),
  index: z.object({
    /** Extra exclusions on top of .gitignore and the built-in sensitive-path list. */
    exclude: z.array(z.string()).default([]),
    maxFileBytes: z.number().int().positive().default(1_000_000),
  }).prefault({}),
  privacy: z.object({
    /** none: not recorded. name: program and subcommand only. redacted: full command with secrets scrubbed. */
    commands: z.enum(['none', 'name', 'redacted']).default('name'),
    capturePrompts: z.boolean().default(false),
  }).prefault({}),
  sync: z.object({
    enabled: z.boolean().default(false),
    /** Also send agent usage to the gateway ledger, where it counts toward budgets. For API-billed usage only. */
    ledger: z.boolean().default(false),
  }).prefault({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

export interface Project {
  repo: RepoInfo;
  dir: string;
  config: ProjectConfig;
}

export const projectDir = (root: string): string => join(root, PROJECT_DIR);
const configPath = (root: string): string => join(projectDir(root), 'config.json');

export function requireRepo(cwd: string): RepoInfo {
  const repo = repoInfo(cwd);
  if (!repo) throw new UsageError(`${cwd} is not inside a Git repository.`, 'Run this from a repository, or start one with `git init`.');
  return repo;
}

export function readProjectConfig(root: string): ProjectConfig | undefined {
  const file = configPath(root);
  if (!existsSync(file)) return undefined;
  try {
    return ProjectConfig.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw new CliError(`${file} is unreadable or invalid.`, 1, 'Fix the file, or delete it and run `tokenistt init` again.');
  }
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export interface InitOutcome {
  project: Project;
  created: boolean;
}

/** Creates what is missing and leaves an existing config untouched, so it is safe to run repeatedly. */
export function initProject(repo: RepoInfo, now: Date = new Date()): InitOutcome {
  const dir = projectDir(repo.root);
  for (const sub of SUBDIRS) mkdirSync(join(dir, sub), { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE);

  const existing = readProjectConfig(repo.root);
  if (existing) return { project: { repo, dir, config: existing }, created: false };

  const config = ProjectConfig.parse({ schemaVersion: 1, projectId: projectIdFor(repo), name: repo.name, createdAt: now.toISOString() });
  writeAtomic(configPath(repo.root), `${JSON.stringify(config, null, 2)}\n`);
  return { project: { repo, dir, config }, created: true };
}

/** The current project, or a clear instruction to create one. */
export function requireProject(cwd: string): Project {
  const repo = requireRepo(cwd);
  const config = readProjectConfig(repo.root);
  if (!config) throw new UsageError(`${repo.root} has no Tokenistt project yet.`, 'Run `tokenistt init` first.');
  return { repo, dir: projectDir(repo.root), config };
}
