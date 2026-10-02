import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  explainLine,
  importPaths,
  initializeProject,
  inspectOccurrence,
  inspectProject,
  recordState,
} from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

// As in git.test.ts: no global or system Git configuration reaches a result.
const isolated = mkdtempSync(join(tmpdir(), 'sulai-worktree-config-'));
writeFileSync(join(isolated, 'gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(isolated, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Sulai Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Sulai Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
});
after(() => rmSync(isolated, { recursive: true, force: true }));

const supported = spawnSync('git', ['--no-lazy-fetch', 'version']).status === 0;
const skip = supported ? false : 'needs git 2.45 or later';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const sha = (content: string | Buffer) =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`;

async function tree(root: string, files: Record<string, string | Buffer>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function setup(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'sulai-worktree-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, 'project');
  await initializeProject(directory);
  return { base, directory };
}

/** A repository with one commit of `files`, and its working tree clean. */
async function repository(
  base: string,
  files: Record<string, string | Buffer>,
  name = 'repo',
) {
  git(base, 'init', '-q', '--initial-branch=main', name);
  const repo = join(base, name);
  await tree(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  return repo;
}

const long_ago = new Date('2001-01-01T00:00:00Z');

test(
  'a working tree is preserved as its bytes: changes, untracked files, and what Git selects',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, {
      '.gitignore': 'node_modules/\n*.log\n',
      'a.txt': 'committed\n',
      'gone.txt': 'deleted soon\n',
    });
    // Tracked although an ignore rule matches it.
    await tree(repo, { 'keep.log': 'kept\n' });
    git(repo, 'add', '-f', 'keep.log');
    git(repo, 'commit', '-q', '-m', 'keep');
    const head = git(repo, 'rev-parse', 'HEAD');
    // Uncommitted work: a change, a deletion, a staged file, an untracked one.
    await tree(repo, {
      'a.txt': 'changed, not committed\n',
      'staged.txt': 'staged\n',
      'notes/plan.md': 'untracked\n',
      'debug.log': 'ignored\n',
    });
    git(repo, 'add', 'staged.txt');
    await rm(join(repo, 'gone.txt'));
    // Large and ignored: none of it may be listed or read.
    const modules: Record<string, string | Buffer> = {
      'node_modules/big.bin': Buffer.alloc(8 * 1024 * 1024, 0x61),
    };
    for (let index = 0; index < 300; index += 1) {
      modules[`node_modules/pkg/${index}.js`] = `module.exports = ${index};\n`;
    }
    await tree(repo, modules);

    const result = await importPaths(directory, [{ worktree: repo }]);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.roots, [
      { id: 'r1', source: 'git-worktree', locator: resolve(repo), head },
    ]);
    const record = await inspectOccurrence(directory, result.occurrenceId);
    assert.equal(record.version, 3);
    assert.deepEqual(record.roots, [
      {
        id: 'r1',
        source: 'git-worktree',
        objectFormat: 'sha1',
        head,
        tree: git(repo, 'rev-parse', 'HEAD^{tree}'),
        selection: 'tracked-and-unignored',
        platform: process.platform,
        locator: resolve(repo),
      },
    ]);
    const files: Record<string, string> = {
      '.gitignore': 'node_modules/\n*.log\n',
      'a.txt': 'changed, not committed\n',
      'keep.log': 'kept\n',
      'notes/plan.md': 'untracked\n',
      'staged.txt': 'staged\n',
    };
    assert.deepEqual(
      record.entries.map((entry) => [entry.path, entry.artifact]),
      Object.entries(files).map(([path, content]) => [path, sha(content)]),
    );
    assert.equal(
      record.entries.every((entry) => 'modifiedAt' in entry),
      true,
    );
    assert.deepEqual(record.skipped, []);
    assert.deepEqual(record.excluded, []);
    // Nothing ignored was read, so no artifact holds it.
    assert.equal(result.newArtifacts, 5);
  },
);

test(
  "the project's store is excluded even when tracked, and when it does not ignore itself",
  { skip },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'sulai-worktree-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const repo = await repository(base, { 'a.txt': 'a\n' });
    await initializeProject(repo);
    // A store made before init asked Git to ignore it is untracked instead.
    await rm(join(repo, '.sulai', '.gitignore'));
    const untracked = await importPaths(repo, [{ worktree: repo }]);
    const first = await inspectOccurrence(repo, untracked.occurrenceId);
    assert.deepEqual(
      first.entries.map((entry) => entry.path),
      ['a.txt'],
    );
    assert.deepEqual(first.excluded, [
      { root: 'r1', path: '.sulai', reason: 'project-store' },
    ]);
    // Even a tracked store is never read as evidence.
    git(repo, 'add', '-f', '.sulai/README.md');
    git(repo, 'commit', '-q', '-m', 'track the store');
    const tracked = await importPaths(repo, [{ worktree: repo }]);
    const second = await inspectOccurrence(repo, tracked.occurrenceId);
    assert.deepEqual(
      second.entries.map((entry) => entry.path),
      ['a.txt'],
    );
    assert.deepEqual(second.excluded, [
      { root: 'r1', path: '.sulai', reason: 'project-store' },
    ]);
  },
);

test(
  'the store is recognized when the project is named through a link',
  { skip },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'sulai-worktree-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    await mkdir(join(base, 'real'));
    // Git names a working tree by its real path; the caller may not.
    await symlink(join(base, 'real'), join(base, 'alias'), 'junction');
    await repository(join(base, 'real'), { 'a.txt': 'a\n' });
    const repo = join(base, 'alias', 'repo');
    await initializeProject(repo);
    await rm(join(repo, '.sulai', '.gitignore'));
    const result = await importPaths(repo, [{ worktree: repo }]);
    const record = await inspectOccurrence(repo, result.occurrenceId);
    assert.deepEqual(
      record.entries.map((entry) => entry.path),
      ['a.txt'],
    );
    assert.deepEqual(record.excluded, [
      { root: 'r1', path: '.sulai', reason: 'project-store' },
    ]);
  },
);

test(
  'a submodule and a nested repository are excluded and not entered',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'a\n' });
    // A gitlink in the index, with a checked-out folder that must not be read.
    const gitlink = '1'.repeat(40);
    git(
      repo,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${gitlink},module`,
    );
    await tree(repo, { 'module/inside.txt': 'another repository\n' });
    // An untracked folder that is a repository of its own.
    git(repo, 'init', '-q', 'nested');
    await tree(repo, { 'nested/n.txt': 'nested\n' });

    const result = await importPaths(directory, [{ worktree: repo }]);
    const record = await inspectOccurrence(directory, result.occurrenceId);
    assert.deepEqual(
      record.entries.map((entry) => entry.path),
      ['a.txt'],
    );
    assert.deepEqual(record.excluded, [
      { root: 'r1', path: 'module', reason: 'submodule', commit: gitlink },
      { root: 'r1', path: 'nested', reason: 'nested-repository' },
    ]);
  },
);

test(
  'an untracked file that vanishes after Git listed it is skipped, so the occurrence is partial',
  {
    skip:
      skip ||
      (process.platform === 'win32' &&
        'Windows finds only git.exe on PATH, so the race cannot be staged'),
  },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'a\n' });
    await tree(repo, {
      'gone.txt': 'listed, then removed\n',
      'moved/inside.txt': 'listed, then its folder became a file\n',
    });
    // A git that, right after listing untracked files, removes one and turns
    // the folder of another into a file: the race, made certain.
    const real = execFileSync('sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    await tree(base, {
      'bin/git': [
        '#!/bin/sh',
        '"$SULAI_TEST_GIT" "$@"',
        'status=$?',
        'case " $* " in',
        '  *" --others "*) rm -rf "$SULAI_TEST_REPO/gone.txt" "$SULAI_TEST_REPO/moved"; printf x > "$SULAI_TEST_REPO/moved" ;;',
        'esac',
        'exit $status',
        '',
      ].join('\n'),
    });
    await chmod(join(base, 'bin', 'git'), 0o755);
    const saved = process.env.PATH;
    Object.assign(process.env, {
      PATH: `${join(base, 'bin')}:${saved}`,
      SULAI_TEST_GIT: real,
      SULAI_TEST_REPO: repo,
    });
    t.after(() => {
      process.env.PATH = saved;
      delete process.env.SULAI_TEST_GIT;
      delete process.env.SULAI_TEST_REPO;
    });

    const result = await importPaths(directory, [{ worktree: repo }]);
    assert.equal(result.status, 'partial');
    const record = await inspectOccurrence(directory, result.occurrenceId);
    assert.deepEqual(
      record.entries.map((entry) => entry.path),
      ['a.txt'],
    );
    assert.deepEqual(record.skipped, [
      { root: 'r1', path: 'gone.txt', reason: 'vanished' },
      { root: 'r1', path: 'moved/inside.txt', reason: 'changed-during-read' },
    ]);
  },
);

test(
  'a working tree in the middle of a merge conflict is refused',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'base\n', 'b.txt': 'b\n' });
    git(repo, 'checkout', '-q', '-b', 'other');
    await writeFile(join(repo, 'a.txt'), 'other\n');
    git(repo, 'commit', '-q', '-am', 'other');
    git(repo, 'checkout', '-q', 'main');
    await writeFile(join(repo, 'a.txt'), 'main\n');
    git(repo, 'commit', '-q', '-am', 'main');
    assert.throws(() => git(repo, 'merge', '-q', 'other'));
    await assert.rejects(
      importPaths(directory, [{ worktree: repo }]),
      /has unmerged paths, from a merge in progress: a\.txt\. Sulai does not observe a working tree with unresolved conflicts/,
    );
    // Once resolved, it is observed again.
    git(repo, 'add', 'a.txt');
    const result = await importPaths(directory, [{ worktree: repo }]);
    assert.equal(result.status, 'complete');
  },
);

test('a symbolic link is skipped and never followed', { skip }, async (t) => {
  const { base, directory } = await setup(t);
  const repo = await repository(base, { 'a.txt': 'a\n' });
  await writeFile(join(base, 'outside.txt'), 'outside the repository\n');
  try {
    await symlink(join(base, 'outside.txt'), join(repo, 'link.txt'));
  } catch {
    t.skip('this system cannot create a symbolic link');
    return;
  }
  const result = await importPaths(directory, [{ worktree: repo }]);
  assert.equal(result.status, 'partial');
  const record = await inspectOccurrence(directory, result.occurrenceId);
  assert.deepEqual(record.skipped, [
    { root: 'r1', path: 'link.txt', reason: 'symbolic-link' },
  ]);
  assert.equal(
    record.entries.some(
      (entry) => entry.artifact === sha('outside the repository\n'),
    ),
    false,
  );
});

test(
  'the working copy of a filtered file is preserved, no filter runs, and the index is untouched',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    git(base, 'init', '-q', '--initial-branch=main', 'repo');
    const repo = join(base, 'repo');
    // A filter that leaves a mark whenever it runs, required so that Git
    // would fail rather than skip it.
    const marker = join(base, 'filter-ran').split(sep).join('/');
    for (const key of ['clean', 'smudge']) {
      git(repo, 'config', `filter.mark.${key}`, `echo ran >> "${marker}"; cat`);
    }
    git(repo, 'config', 'filter.mark.required', 'true');
    await tree(repo, {
      '.gitattributes': '*.txt filter=mark\n',
      'note.txt': 'as committed\n',
    });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'filtered');
    await rm(marker, { force: true });
    // What the agent reads is the working copy, whatever the commit holds. It
    // keeps the committed length, so `git status` below must rehash it.
    await writeFile(join(repo, 'note.txt'), 'AS COMMITTED\n');
    // Stale cached details would make `git status` rehash through the filter.
    await utimes(join(repo, 'note.txt'), long_ago, long_ago);
    const index = join(repo, '.git', 'index');
    const before = { bytes: await readFile(index), stat: await stat(index) };

    const result = await importPaths(directory, [{ worktree: repo }]);
    const record = await inspectOccurrence(directory, result.occurrenceId);
    assert.equal(
      record.entries.find((entry) => entry.path === 'note.txt')?.artifact,
      sha('AS COMMITTED\n'),
    );
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    const after = await stat(index);
    assert.deepEqual(await readFile(index), before.bytes);
    assert.equal(after.mtimeMs, before.stat.mtimeMs);
    // The same file through `git status` does run the filter, so the
    // assertion above can fail.
    git(repo, 'status', '--porcelain');
    assert.equal((await stat(marker)).isFile(), true);
  },
);

test(
  'before the first commit, HEAD and its tree are null and the files are still preserved',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    git(base, 'init', '-q', '--initial-branch=main', 'fresh');
    const repo = join(base, 'fresh');
    await tree(repo, { 'staged.txt': 'staged\n', 'loose.txt': 'loose\n' });
    git(repo, 'add', 'staged.txt');
    const result = await importPaths(directory, [{ worktree: repo }]);
    const record = await inspectOccurrence(directory, result.occurrenceId);
    const [root] = record.roots;
    assert.equal(root?.source === 'git-worktree' && root.head, null);
    assert.equal(root?.source === 'git-worktree' && root.tree, null);
    assert.deepEqual(
      record.entries.map((entry) => entry.path),
      ['loose.txt', 'staged.txt'],
    );
  },
);

test(
  'part of a repository and a bare repository are refused',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'src/a.txt': 'a\n' });
    await assert.rejects(
      importPaths(directory, [{ worktree: join(repo, 'src') }]),
      /inside the repository/,
    );
    git(base, 'init', '-q', '--bare', 'bare.git');
    await assert.rejects(
      importPaths(directory, [{ worktree: join(base, 'bare.git') }]),
      /bare repository, which has no working tree/,
    );
  },
);

test(
  'a citation into a working tree resolves as one into a folder, and why names HEAD',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'one\ntwo\n' });
    await writeFile(join(repo, 'a.txt'), 'one\nTWO, uncommitted\n');
    const result = await importPaths(directory, [{ worktree: repo }]);
    const recorded = await recordState(
      directory,
      Buffer.from('The second line `r1/a.txt#L2`\n'),
      result.occurrenceId,
    );
    assert.match(recorded.id, /^state:v3:/);
    assert.equal(recorded.references.resolved, 1);
    const why = await explainLine(directory, recorded.id, 1);
    const [cited] = why.references;
    assert.equal(
      cited?.status === 'resolved' ? cited.evidence : undefined,
      'TWO, uncommitted',
    );
    assert.deepEqual(why.references[0]?.where, {
      root: 'r1',
      locator: resolve(repo),
      head: git(repo, 'rev-parse', 'HEAD'),
      path: 'a.txt',
    });
    // The whole store verifies, version 3 records included.
    const inspection = await inspectProject(directory);
    assert.equal(inspection.version, 6);
    assert.equal(inspection.states.length, 1);
  },
);

test(
  'the command line imports a working tree with --worktree',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'a\n' });
    await writeFile(join(repo, 'b.txt'), 'b\n');
    const run = spawnSync(
      process.execPath,
      [cli, 'import', directory, '--worktree', repo],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const printed = JSON.parse(run.stdout) as {
      roots: { source: string }[];
      entryCount: number;
    };
    assert.equal(printed.roots[0]?.source, 'git-worktree');
    assert.equal(printed.entryCount, 2);
  },
);
