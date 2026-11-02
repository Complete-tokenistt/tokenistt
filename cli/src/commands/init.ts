import type { Command } from 'commander';
import { motionAllowed, Progress } from '../core/progress.js';
import { detectProject } from '../project/detect.js';
import { listFiles } from '../project/git.js';
import { openDatabase, SCHEMA_VERSION } from '../store/db.js';
import { initProject, requireRepo } from '../store/project.js';
import type { Context } from '../context.js';

type GetCtx = (cmd: Command) => Context;

export function registerInit(program: Command, getCtx: GetCtx): void {
  program
    .command('init')
    .description('Set up this repository: creates .tokenistt/ and the local database. Safe to re-run; needs no network')
    .action((_o: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const progress = new Progress({ silent: ctx.out.json || ctx.out.quiet, motion: motionAllowed(ctx.env, process.stderr.isTTY), color: ctx.out.color });
      try {
        progress.start('Detecting Git repository');
        const repo = requireRepo(process.cwd());
        progress.succeed(`${repo.name}${repo.branch ? ` on ${repo.branch}` : ''}`);

        progress.start('Scanning project files');
        const detection = detectProject(repo.root, listFiles(repo.root));
        progress.succeed(`${detection.fileCount} files`);

        progress.start('Writing project configuration');
        const { project, created } = initProject(repo);
        progress.succeed(created ? '.tokenistt/config.json' : 'kept existing .tokenistt/config.json');

        progress.start('Preparing local database');
        openDatabase(repo.root).close();
        progress.succeed(`schema ${SCHEMA_VERSION}`);
        progress.stop();

        ctx.out.result({ created, project_id: project.config.projectId, name: project.config.name, root: repo.root, branch: repo.branch ?? null, commit: repo.commit ?? null, ...detection }, () => {
          ctx.out.line(`${ctx.out.bold(project.config.name)}  ${project.config.projectId}`);
          if (detection.languages.length) ctx.out.line(`Languages:  ${detection.languages.map((l) => `${l.language} (${l.files})`).join(', ')}`);
          if (detection.frameworks.length) ctx.out.line(`Frameworks: ${detection.frameworks.join(', ')}`);
          if (detection.packageManagers.length) ctx.out.line(`Packages:   ${detection.packageManagers.join(', ')}`);
          ctx.out.info('');
          ctx.out.info(created ? 'Commit .tokenistt/config.json to share these settings; everything else there stays local.' : 'Already set up; nothing was overwritten.');
        });
      } catch (err) {
        progress.fail();
        throw err;
      } finally {
        progress.stop();
      }
    });
}
