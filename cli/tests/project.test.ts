import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Progress, motionAllowed } from '../src/core/progress.js';
import { detectProject } from '../src/project/detect.js';
import { listFiles, normalizeRemote, projectIdFor, repoInfo } from '../src/project/git.js';
import { migrate, openDatabase, SCHEMA_VERSION } from '../src/store/db.js';
import { initProject, ProjectConfig, readProjectConfig, requireProject } from '../src/store/project.js';
import { gitRepo, tempDir } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function repo(files: Record<string, string> = {}): string {
  const t = gitRepo(files);
  cleanups.push(t.cleanup);
  return t.dir;
}

describe('normalizeRemote', () => {
  it('reduces every remote form to the same host/path', () => {
    for (const u of ['git@github.com:Acme/App.git', 'https://github.com/Acme/App.git', 'ssh://git@github.com/Acme/App', 'https://github.com/Acme/App/']) {
      assert.equal(normalizeRemote(u), 'github.com/Acme/App');
    }
  });
  it('drops credentials embedded in the URL', () => {
    const r = normalizeRemote('https://user:ghp_secret123@github.com/acme/app.git');
    assert.equal(r, 'github.com/acme/app');
  });
  it('returns nothing for junk', () => assert.equal(normalizeRemote('  '), undefined));
});

describe('repo detection', () => {
  it('reports branch and commit, and is undefined outside a repo', () => {
    const info = repoInfo(repo({ 'a.ts': 'x' }));
    assert.equal(info?.branch, 'main');
    assert.equal(info?.commitSubject, 'first');
    const outside = tempDir();
    cleanups.push(outside.cleanup);
    assert.equal(repoInfo(outside.dir), undefined);
  });
  it('handles a repo with no commits', () => {
    const info = repoInfo(repo());
    assert.ok(info);
    assert.equal(info.commit, undefined);
    assert.equal(info.branch, 'main');
    assert.match(projectIdFor(info), /^repo_[0-9a-f]{16}$/);
  });
  it('lists tracked and untracked files but not ignored ones', () => {
    const dir = repo({ '.gitignore': 'secret.txt\nnode_modules/\n', 'a.ts': 'x' });
    writeFileSync(join(dir, 'new.ts'), 'y');
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'dep.js'), 'z');
    assert.deepEqual(listFiles(dir).sort(), ['.gitignore', 'a.ts', 'new.ts']);
  });
  it('gives clones of the same remote the same project id', () => {
    const a = { root: '/a', name: 'x', remote: 'github.com/acme/app' };
    const b = { root: '/somewhere/else', name: 'x', remote: 'github.com/acme/app' };
    assert.equal(projectIdFor(a), projectIdFor(b));
  });
});

describe('detectProject', () => {
  it('finds languages, frameworks and package managers, including in nested workspaces', () => {
    const dir = repo({
      'package-lock.json': '{}',
      'apps/web/package.json': JSON.stringify({ dependencies: { next: '15', react: '19' } }),
      'apps/api/package.json': JSON.stringify({ dependencies: { express: '5' }, devDependencies: { 'drizzle-orm': '1' } }),
      'apps/web/page.tsx': '', 'apps/api/a.ts': '', 'svc/requirements.txt': 'FastAPI==0.1\n', 'svc/m.py': '', 'db/schema.sql': '', 'README.md': '',
    });
    const d = detectProject(dir, listFiles(dir));
    assert.deepEqual(d.frameworks, ['drizzle', 'express', 'fastapi', 'nextjs', 'react']);
    assert.deepEqual(d.packageManagers, ['npm', 'pip']);
    assert.equal(d.languages.find((l) => l.language === 'typescript')?.files, 2);
    assert.equal(d.languages.find((l) => l.language === 'sql')?.files, 1);
  });
  it('tolerates a malformed manifest', () => {
    const dir = repo({ 'package.json': '{ not json' });
    assert.deepEqual(detectProject(dir, listFiles(dir)).frameworks, []);
  });
});

describe('.tokenistt project', () => {
  it('creates the layout and keeps local data out of git', () => {
    const dir = repo({ 'a.ts': 'x' });
    const { created, project } = initProject(repoInfo(dir)!);
    assert.equal(created, true);
    for (const d of ['database', 'graph', 'memory', 'sessions', 'cache', 'logs', 'exports']) assert.ok(existsSync(join(dir, '.tokenistt', d)), d);
    writeFileSync(join(dir, '.tokenistt', 'sessions', 'x.jsonl'), '{}');
    assert.deepEqual(listFiles(dir).filter((f) => f.startsWith('.tokenistt')).sort(), ['.tokenistt/.gitignore', '.tokenistt/config.json']);
    assert.equal(project.config.privacy.commands, 'name');
    assert.equal(project.config.privacy.capturePrompts, false);
    assert.equal(project.config.sync.enabled, false);
  });
  it('never overwrites an existing config', () => {
    const dir = repo({ 'a.ts': 'x' });
    const info = repoInfo(dir)!;
    initProject(info);
    const file = join(dir, '.tokenistt', 'config.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), name: 'renamed' }));
    assert.equal(initProject(info).created, false);
    assert.equal(readProjectConfig(dir)?.name, 'renamed');
  });
  it('rejects an invalid config with a hint', () => {
    const dir = repo({ 'a.ts': 'x' });
    initProject(repoInfo(dir)!);
    writeFileSync(join(dir, '.tokenistt', 'config.json'), '{"schemaVersion":99}');
    assert.throws(() => readProjectConfig(dir), /invalid/);
  });
  it('requireProject explains what to do', () => {
    assert.throws(() => requireProject(repo({ 'a.ts': 'x' })), /no Tokenistt project/);
  });
  it('fills defaults for a minimal config', () => {
    const c = ProjectConfig.parse({ schemaVersion: 1, projectId: 'repo_0123456789abcdef', name: 'x', createdAt: 'now' });
    assert.equal(c.index.maxFileBytes, 1_000_000);
  });
});

describe('local database', () => {
  it('migrates once and reopens at the same version', () => {
    const dir = repo({ 'a.ts': 'x' });
    const db = openDatabase(dir);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('k', 'v');
    db.close();
    const again = openDatabase(dir);
    assert.equal((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.equal((again.prepare('SELECT value FROM meta WHERE key = ?').get('k') as { value: string }).value, 'v');
    again.close();
  });
  it('has FTS5 available', () => {
    const db = openDatabase(repo());
    db.exec("CREATE VIRTUAL TABLE t USING fts5(a); INSERT INTO t VALUES ('auth flow');");
    assert.equal((db.prepare("SELECT count(*) AS c FROM t WHERE t MATCH 'auth'").get() as { c: number }).c, 1);
    db.close();
  });
  it('rolls back a failed migration and leaves the version alone', () => {
    const db = openDatabase(repo());
    assert.throws(() => migrate(db, [...Array<string>(SCHEMA_VERSION).fill(''), 'CREATE TABLE ok (a INT); CREATE TABLE broken (']));
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ok'").get(), undefined);
    db.close();
  });
  it('refuses a database newer than this CLI', () => {
    const db = openDatabase(repo());
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    assert.throws(() => migrate(db), /newer than this CLI/);
    db.close();
  });
});

describe('Progress', () => {
  const capture = () => { let s = ''; return { write: (x: string) => { s += x; }, get text() { return s; } }; };

  it('prints plain lines without redraw codes when motion is off', () => {
    const stream = capture();
    const p = new Progress({ stream });
    p.start('Indexing');
    p.update(3, 10);
    p.succeed('10 files');
    p.start('Linking');
    p.fail('boom');
    p.stop();
    assert.equal(stream.text, '✔ Indexing  10 files\n✖ Linking  boom\n');
  });
  it('is silent when asked', () => {
    const stream = capture();
    const p = new Progress({ stream, silent: true, motion: true });
    p.start('x');
    p.succeed();
    p.stop();
    assert.equal(stream.text, '');
  });
  it('restores the cursor after animating', () => {
    const stream = capture();
    const p = new Progress({ stream, motion: true, intervalMs: 1000 });
    p.start('x');
    p.update(1);
    p.succeed();
    p.stop();
    assert.ok(stream.text.includes('\x1b[?25l'));
    assert.ok(stream.text.endsWith('\x1b[?25h'));
  });
  it('turns motion off for CI, non-TTY, dumb terminals and reduced motion', () => {
    assert.equal(motionAllowed({}, true), true);
    assert.equal(motionAllowed({}, false), false);
    assert.equal(motionAllowed({ CI: 'true' }, true), false);
    assert.equal(motionAllowed({ TERM: 'dumb' }, true), false);
    assert.equal(motionAllowed({ TOKENISTT_REDUCED_MOTION: '1' }, true), false);
  });
});
