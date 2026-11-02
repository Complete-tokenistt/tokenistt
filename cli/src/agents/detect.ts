/** Finds a program on PATH without running anything. */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
