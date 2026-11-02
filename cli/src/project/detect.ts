/** What a repository is made of, from file names and manifests. Nothing is executed. */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.java': 'java', '.go': 'go', '.rs': 'rust', '.php': 'php', '.cs': 'csharp',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.sql': 'sql', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
};

const NPM_FRAMEWORKS: Record<string, string> = {
  next: 'nextjs', react: 'react', express: 'express', '@nestjs/core': 'nestjs',
  'drizzle-orm': 'drizzle', prisma: 'prisma', '@prisma/client': 'prisma', '@supabase/supabase-js': 'supabase',
};
const PYTHON_FRAMEWORKS: Record<string, string> = { fastapi: 'fastapi', django: 'django' };

const LOCKFILES: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm'],
  ['poetry.lock', 'poetry'], ['uv.lock', 'uv'], ['Pipfile.lock', 'pipenv'], ['requirements.txt', 'pip'],
  ['go.mod', 'go'], ['Cargo.toml', 'cargo'], ['pom.xml', 'maven'], ['build.gradle', 'gradle'], ['build.gradle.kts', 'gradle'], ['composer.json', 'composer'],
];

export interface Detection {
  fileCount: number;
  languages: Array<{ language: string; files: number }>;
  frameworks: string[];
  packageManagers: string[];
}

function read(root: string, rel: string): string | undefined {
  const p = join(root, rel);
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

export function detectProject(root: string, files: string[]): Detection {
  const counts = new Map<string, number>();
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();

  for (const f of files) {
    const language = LANGUAGE_BY_EXTENSION[posix.extname(f).toLowerCase()];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);

    const base = posix.basename(f);
    for (const [lock, manager] of LOCKFILES) if (base === lock) packageManagers.add(manager);
    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(read(root, f) ?? '{}') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
          const fw = NPM_FRAMEWORKS[dep];
          if (fw) frameworks.add(fw);
        }
      } catch {
        /* a malformed manifest says nothing about the stack */
      }
    } else if (base === 'requirements.txt' || base === 'pyproject.toml') {
      const text = (read(root, f) ?? '').toLowerCase();
      for (const [dep, fw] of Object.entries(PYTHON_FRAMEWORKS)) if (new RegExp(`\\b${dep}\\b`).test(text)) frameworks.add(fw);
    } else if (base === 'pom.xml' || base === 'build.gradle' || base === 'build.gradle.kts') {
      if ((read(root, f) ?? '').includes('spring-boot')) frameworks.add('spring-boot');
    } else if (base === 'schema.prisma') {
      frameworks.add('prisma');
    }
  }

  return {
    fileCount: files.length,
    languages: [...counts].map(([language, n]) => ({ language, files: n })).sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)),
    frameworks: [...frameworks].sort(),
    packageManagers: [...packageManagers].sort(),
  };
}
