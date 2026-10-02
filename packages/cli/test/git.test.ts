import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeOccurrence } from '@sulai/core';
import {
  explainLine,
  importPaths,
  initializeProject,
  inspectOccurrence,
  inspectProject,
  inspectState,
  recordState,
} from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

// Git runs here with no global or system configuration, so what the machine
// has configured, such as a global LFS filter, cannot change a result.
const isolated = mkdtempSync(join(tmpdir(), 'sulai-git-config-'));
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

function gitWith(cwd: string, input: string | Buffer, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
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
  const base = await mkdtemp(join(tmpdir(), 'sulai-git-'));
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

/** A bare repository whose one commit holds exactly the tree given. */
function bareRepository(
  base: string,
  entries: (repo: string) => [string, string, string, string | Buffer][],
) {
  git(base, 'init', '-q', '--bare', '--initial-branch=main', 'repo.git');
  const repo = join(base, 'repo.git');
  const input = Buffer.concat(
    entries(repo).map(([mode, type, id, name]) =>
      Buffer.concat([
        Buffer.from(`${mode} ${type} ${id}\t`),
        Buffer.from(name),
        Buffer.from([0]),
      ]),
    ),
  );
  const root = gitWith(repo, input, 'mktree', '-z', '--missing');
  const commit = gitWith(repo, 'crafted\n', 'commit-tree', root);
  git(repo, 'update-ref', 'refs/heads/main', commit);
  return { repo, commit, tree: root };
}

const blob = (repo: string, content: string | Buffer) =>
  gitWith(repo, content, 'hash-object', '-w', '--stdin');

async function storedArtifacts(directory: string) {
  return (await readdir(join(directory, '.sulai', 'artifacts'))).map(
    (name) => `sha256:${name.slice(0, 64)}`,
  );
}

const long_ago = new Date('2001-01-01T00:00:00Z');

/** What the first root of an acquisition says about its working tree. */
const worktree = (result: Awaited<ReturnType<typeof importPaths>>) =>
  result.roots[0]?.source === 'git' ? result.roots[0].worktree : undefined;

test(
  'a git that cannot refuse to fetch is refused',
  { skip: supported && 'this git can refuse to fetch' },
  async (t) => {
    const { base, directory } = await setup(t);
    await assert.rejects(
      importPaths(directory, [{ git: base }]),
      /needs git 2\.45 or later/,
    );
  },
);

test(
  'a Git root records the commit and its tracked files, and nothing untracked or ignored',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, {
      '.gitignore': 'node_modules/\n*.log\n',
      'README.md': '# Demo\n',
      'src/app.ts': 'export const x = 1;\n',
      'bin/run': '#!/bin/sh\necho run\n',
    });
    // Executable in the commit and, where the filesystem has the bit, on disk.
    await chmod(join(repo, 'bin', 'run'), 0o755);
    git(repo, 'update-index', '--chmod=+x', 'bin/run');
    git(repo, 'commit', '-q', '-m', 'executable');
    // Large, untracked and ignored: none of it may be read.
    const modules: Record<string, string | Buffer> = {
      'node_modules/big.bin': Buffer.alloc(8 * 1024 * 1024, 0x61),
    };
    for (let index = 0; index < 500; index += 1) {
      modules[`node_modules/pkg/${index}.js`] = `module.exports = ${index};\n`;
    }
    await tree(repo, { ...modules, 'debug.log': 'noise\n' });

    const result = await importPaths(directory, [{ git: repo }]);
    const commit = git(repo, 'rev-parse', 'HEAD');
    assert.deepEqual(result.roots, [
      {
        id: 'r1',
        source: 'git',
        locator: resolve(repo),
        commit,
        worktree: 'clean',
      },
    ]);
    assert.equal(result.status, 'complete');
    assert.equal(result.entryCount, 4);

    const record = await inspectOccurrence(directory, result.occurrenceId);
    assert.equal(record.version, 3);
    assert.deepEqual(record.roots, [
      {
        id: 'r1',
        source: 'git',
        objectFormat: 'sha1',
        commit,
        tree: git(repo, 'rev-parse', 'HEAD^{tree}'),
        worktree: 'clean',
        platform: process.platform,
        locator: resolve(repo),
      },
    ]);
    const files: Record<string, string> = {
      '.gitignore': 'node_modules/\n*.log\n',
      'README.md': '# Demo\n',
      'bin/run': '#!/bin/sh\necho run\n',
      'src/app.ts': 'export const x = 1;\n',
    };
    assert.deepEqual(
      record.entries.map((entry) => ({ ...entry })),
      Object.entries(files).map(([path, content]) => ({
        root: 'r1',
        path,
        artifact: sha(content),
        byteLength: Buffer.byteLength(content),
        mode: path === 'bin/run' ? '100755' : '100644',
        blob: git(repo, 'rev-parse', `HEAD:${path}`),
        new: true,
      })),
    );
    assert.deepEqual(
      (await storedArtifacts(directory)).sort(),
      Object.values(files).map(sha).sort(),
    );
  },
);

test(
  'uncommitted work refuses the acquisition and is never mistaken for the commit',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, {
      'README.md': 'committed\n',
      'b.txt': 'b\n',
    });
    const changes: [string, () => Promise<void>, () => void][] = [
      [
        'README.md',
        () => writeFile(join(repo, 'README.md'), 'changed\n'),
        () => git(repo, 'checkout', '--', 'README.md'),
      ],
      [
        'staged.txt',
        async () => {
          await writeFile(join(repo, 'staged.txt'), 'staged\n');
          git(repo, 'add', 'staged.txt');
        },
        () => git(repo, 'rm', '-q', '--cached', 'staged.txt'),
      ],
      [
        'untracked.txt',
        () => writeFile(join(repo, 'untracked.txt'), 'u\n'),
        () => {},
      ],
    ];
    for (const [path, change, undo] of changes) {
      await change();
      await assert.rejects(
        importPaths(directory, [{ git: repo }]),
        new RegExp(
          `working tree differs from commit [0-9a-f]{12} in 1 path\\(s\\): ${path.replace('.', '\\.')}\\..*--allow-uncommitted`,
        ),
        path,
      );
      await undo();
      await rm(join(repo, 'staged.txt'), { force: true });
      await rm(join(repo, 'untracked.txt'), { force: true });
    }
    // A refusal records nothing and stores nothing.
    assert.deepEqual(
      await readdir(join(directory, '.sulai', 'occurrences')),
      [],
    );
    assert.deepEqual(await storedArtifacts(directory), []);

    await writeFile(join(repo, 'README.md'), 'changed\n');
    const cliRefused = spawnSync(
      process.execPath,
      [cli, 'import', directory, '--git', repo],
      { encoding: 'utf8' },
    );
    assert.equal(cliRefused.status, 1);
    assert.match(cliRefused.stderr, /--allow-uncommitted/);
    const anyway = spawnSync(
      process.execPath,
      [cli, 'import', directory, '--git', repo, '--allow-uncommitted'],
      { encoding: 'utf8' },
    );
    assert.equal(anyway.status, 0, anyway.stderr);
    const result = JSON.parse(anyway.stdout) as {
      occurrenceId: string;
      roots: { worktree: string }[];
    };
    assert.equal(result.roots[0]?.worktree, 'differs');
    // What is captured is the commit, not the changed file.
    const record = await inspectOccurrence(directory, result.occurrenceId);
    const readme = record.entries.find((entry) => entry.path === 'README.md');
    assert.equal(readme?.artifact, sha('committed\n'));
    assert.equal(
      (await storedArtifacts(directory)).includes(sha('changed\n')),
      false,
    );
  },
);

test(
  'two acquisitions of one commit share every artifact and are two occurrences',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'a\n', 'b/c.txt': 'c\n' });
    const first = await importPaths(directory, [{ git: repo }]);
    const second = await importPaths(directory, [{ git: repo }]);
    assert.notEqual(first.occurrenceId, second.occurrenceId);
    assert.equal(first.newArtifacts, 2);
    assert.equal(second.newArtifacts, 0);
    assert.equal(second.existingArtifacts, 2);
    const a = await inspectOccurrence(directory, first.occurrenceId);
    const b = await inspectOccurrence(directory, second.occurrenceId);
    assert.deepEqual(
      a.entries.map((entry) => entry.artifact),
      b.entries.map((entry) => entry.artifact),
    );
    assert.equal((await storedArtifacts(directory)).length, 2);
  },
);

test(
  'a symbolic link is kept as its target and never followed; a submodule is excluded, not entered',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    await tree(base, { 'outside/secret.txt': 'SECRET\n' });
    const gitlink = '5'.repeat(40);
    const { repo, commit } = bareRepository(base, (repo) => [
      ['100644', 'blob', blob(repo, 'plain\n'), 'plain.txt'],
      ['120000', 'blob', blob(repo, '../outside/secret.txt'), 'link'],
      ['160000', 'commit', gitlink, 'module'],
    ]);
    const result = await importPaths(directory, [{ git: repo }]);
    // A bare repository has no working tree to compare.
    assert.equal(result.roots[0]?.source, 'git');
    assert.deepEqual(result.roots[0], {
      id: 'r1',
      source: 'git',
      locator: resolve(repo),
      commit,
      worktree: 'absent',
    });
    assert.deepEqual(result.excluded, [
      { root: 'r1', path: 'module', reason: 'submodule', commit: gitlink },
    ]);
    const record = await inspectOccurrence(directory, result.occurrenceId);
    const link = record.entries.find((entry) => entry.path === 'link');
    assert.deepEqual(link && { ...link }, {
      root: 'r1',
      path: 'link',
      artifact: sha('../outside/secret.txt'),
      byteLength: 21,
      mode: '120000',
      blob: blob(repo, '../outside/secret.txt'),
      new: true,
    });
    assert.equal(
      (await storedArtifacts(directory)).includes(sha('SECRET\n')),
      false,
    );
    // Citing into the submodule stays unresolved: it was not captured.
    const state = await recordState(
      directory,
      Buffer.from('See `r1/module/x.md#L1` and `r1/plain.txt#L1`.\n'),
      result.occurrenceId,
    );
    assert.deepEqual(state.references.unresolved, [
      { locator: 'r1/module/x.md#L1', reason: 'not-captured' },
    ]);
  },
);

test(
  'a path that is not valid UTF-8 is skipped, as in a folder',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const { repo } = bareRepository(base, (repo) => [
      ['100644', 'blob', blob(repo, 'ok\n'), 'ok.txt'],
      [
        '100644',
        'blob',
        blob(repo, 'bad\n'),
        Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]),
      ],
    ]);
    const cliRun = spawnSync(
      process.execPath,
      [cli, 'import', directory, '--git', repo],
      { encoding: 'utf8' },
    );
    assert.equal(cliRun.status, 3, cliRun.stderr);
    const result = JSON.parse(cliRun.stdout) as {
      status: string;
      entryCount: number;
      skipped: unknown[];
    };
    assert.equal(result.status, 'partial');
    assert.equal(result.entryCount, 1);
    assert.deepEqual(result.skipped, [
      { root: 'r1', path: 'bad�.txt', reason: 'non-utf8-name' },
    ]);
  },
);

test(
  'a tracked path under .sulai is preserved, and the store in the working tree is not work',
  { skip },
  async (t) => {
    const { base } = await setup(t);
    const repo = await repository(base, {
      '.sulai/notes.md': 'tracked\n',
      'a.txt': 'a\n',
    });
    // The project's own store, untracked, inside the working tree.
    await initializeProject(repo);
    const result = await importPaths(repo, [{ git: repo }]);
    assert.equal(
      result.roots[0]?.source === 'git' && result.roots[0].worktree,
      'clean',
    );
    const record = await inspectOccurrence(repo, result.occurrenceId);
    assert.deepEqual(
      record.entries.map((entry) => entry.path),
      ['.sulai/notes.md', 'a.txt'],
    );
    // Anything else untracked still counts, and an untracked folder is named
    // whole rather than file by file.
    await tree(repo, { 'new/a.txt': 'a\n', 'new/b.txt': 'b\n' });
    await assert.rejects(
      importPaths(repo, [{ git: repo }]),
      /in 1 path\(s\): new\/\./,
    );
  },
);

test(
  'an untracked store in the working tree is passed over whole, however much it holds',
  { skip },
  async (t) => {
    const { base } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await initializeProject(repo);
    // A store made before init asked Git to ignore it is untracked instead.
    await rm(join(repo, '.sulai', '.gitignore'));
    for (let index = 0; index < 3; index += 1) {
      const result = await importPaths(repo, [{ git: repo }]);
      assert.equal(worktree(result), 'clean');
    }
    // Git names the store as one folder, not as the records it holds.
    assert.equal(
      git(repo, 'status', '--porcelain=v1', '--untracked-files=normal'),
      '?? .sulai/',
    );
  },
);

test(
  'a filter that transforms files is not run, so a stale file counts as changed',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    git(base, 'init', '-q', 'repo');
    const repo = join(base, 'repo');
    // The commit holds lowercase text; the working copy is what the filter
    // makes of it.
    git(repo, 'config', 'filter.upper.clean', 'tr A-Z a-z');
    git(repo, 'config', 'filter.upper.smudge', 'tr a-z A-Z');
    await tree(repo, {
      '.gitattributes': '*.txt filter=upper\n',
      'note.txt': 'HELLO\n',
    });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'filtered');
    assert.equal(git(repo, 'cat-file', '-p', 'HEAD:note.txt'), 'hello');
    // With fresh cached details nothing is rehashed, and the check agrees
    // with Git.
    await utimes(join(repo, 'note.txt'), long_ago, long_ago);
    git(repo, 'update-index', '-q', '--refresh');
    assert.equal(
      worktree(await importPaths(directory, [{ git: repo }])),
      'clean',
    );
    // With stale ones the file is rehashed as it is, with no filter, so it
    // differs from the commit.
    const later = new Date('2002-01-01T00:00:00Z');
    await utimes(join(repo, 'note.txt'), later, later);
    await assert.rejects(
      importPaths(directory, [{ git: repo }]),
      /in 1 path\(s\): note\.txt\./,
    );
    const anyway = await importPaths(directory, [{ git: repo }], {
      allowUncommitted: true,
    });
    assert.equal(worktree(anyway), 'differs');
    const record = await inspectOccurrence(directory, anyway.occurrenceId);
    const note = record.entries.find((entry) => entry.path === 'note.txt');
    assert.equal(note?.artifact, sha('hello\n'));
    // Git, which runs the filter, calls the same working tree clean.
    assert.equal(git(repo, 'status', '--porcelain'), '');
  },
);

test(
  'no trace output is written, whether the environment or the configuration asks for it',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'a\n' });
    const traces = join(base, 'traces');
    await mkdir(traces);
    const target = (name: string) => join(traces, name).split(sep).join('/');
    const configuration = join(isolated, 'gitconfig');
    const traceConfiguration = `[trace2]\n\tnormalTarget = ${target('config-normal')}\n\teventTarget = ${target('config-event')}\n\tperfTarget = ${target('config-perf')}\n`;
    const variables = {
      GIT_TRACE: target('trace'),
      GIT_TRACE_PERFORMANCE: target('performance'),
      GIT_TRACE2: target('trace2'),
      GIT_TRACE2_EVENT: target('trace2-event'),
      GIT_REDIRECT_STDERR: target('stderr'),
    };
    await writeFile(configuration, traceConfiguration);
    Object.assign(process.env, variables);
    try {
      await importPaths(directory, [{ git: repo }]);
    } finally {
      for (const name of Object.keys(variables)) delete process.env[name];
      await writeFile(configuration, '');
    }
    assert.deepEqual(await readdir(traces), []);
    // The same configuration makes an ordinary git write, so the check above
    // can fail.
    await writeFile(configuration, traceConfiguration);
    try {
      git(repo, 'rev-parse', 'HEAD');
    } finally {
      await writeFile(configuration, '');
    }
    assert.notDeepEqual(await readdir(traces), []);
  },
);

test(
  'an LFS pointer stays a pointer, and checking the working tree runs no filter',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12345\n`;
    const repo = await repository(base, {
      '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
      'model.bin': pointer,
    });
    // A filter that leaves a mark whenever it runs, required so that Git would
    // fail rather than skip it.
    const marker = join(base, 'filter-ran').split(sep).join('/');
    for (const key of ['clean', 'smudge']) {
      git(repo, 'config', `filter.lfs.${key}`, `echo ran >> "${marker}"; cat`);
    }
    git(repo, 'config', 'filter.lfs.required', 'true');
    // Stale cached details make Git rehash the file, through its filter.
    await utimes(join(repo, 'model.bin'), long_ago, long_ago);

    const result = await importPaths(directory, [{ git: repo }]);
    assert.equal(
      result.roots[0]?.source === 'git' && result.roots[0].worktree,
      'clean',
    );
    await assert.rejects(stat(marker), { code: 'ENOENT' });
    const record = await inspectOccurrence(directory, result.occurrenceId);
    const model = record.entries.find((entry) => entry.path === 'model.bin');
    assert.equal(model?.artifact, sha(pointer));
    // The same check without Sulai's settings does run the filter, so the
    // assertion above can fail.
    git(repo, 'status', '--porcelain');
    assert.equal((await stat(marker)).isFile(), true);
  },
);

test(
  'export-ignore and export-subst do not change what is captured',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const files = {
      '.gitattributes': 'ignored.txt export-ignore\nsubst.txt export-subst\n',
      'ignored.txt': 'still here\n',
      'subst.txt': 'commit $Format:%H$\n',
    };
    const repo = await repository(base, files);
    const result = await importPaths(directory, [{ git: repo }]);
    const record = await inspectOccurrence(directory, result.occurrenceId);
    assert.deepEqual(
      record.entries.map((entry) => [entry.path, entry.artifact]),
      Object.entries(files).map(([path, content]) => [path, sha(content)]),
    );
  },
);

test(
  'a replacement ref does not change what is captured',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'original\n' });
    const original = git(repo, 'rev-parse', 'HEAD:a.txt');
    git(repo, 'replace', original, blob(repo, 'replaced\n'));
    assert.equal(git(repo, 'cat-file', '-p', original), 'replaced');
    const result = await importPaths(directory, [{ git: repo }]);
    const record = await inspectOccurrence(directory, result.occurrenceId);
    assert.deepEqual(
      record.entries.map((entry) => [
        entry.artifact,
        'blob' in entry && entry.blob,
      ]),
      [[sha('original\n'), original]],
    );
  },
);

test(
  'a partial clone missing a blob refuses, and nothing is fetched',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const source = await repository(base, { 'a.txt': 'alpha\n' }, 'source');
    git(source, 'config', 'uploadpack.allowFilter', 'true');
    git(
      base,
      'clone',
      '-q',
      '--bare',
      '--filter=blob:none',
      pathToFileURL(source).href,
      'partial.git',
    );
    const partial = join(base, 'partial.git');
    const missing = git(source, 'rev-parse', 'HEAD:a.txt');
    await assert.rejects(
      importPaths(directory, [{ git: partial }]),
      /Blob [0-9a-f]{40} is not in .*partial clone may lack it, and Sulai never fetches/,
    );
    // Still missing, although the source it came from could have served it.
    const present = spawnSync(
      'git',
      ['-C', partial, 'cat-file', '-e', missing],
      {
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      },
    );
    assert.notEqual(present.status, 0);
    assert.deepEqual(
      await readdir(join(directory, '.sulai', 'occurrences')),
      [],
    );
  },
);

test(
  'checking the working tree leaves the index untouched',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'a\n' });
    // Stale cached details: an ordinary status would refresh and rewrite them.
    await utimes(join(repo, 'a.txt'), long_ago, long_ago);
    const index = join(repo, '.git', 'index');
    const before = await readFile(index);
    const modified = (await stat(index)).mtimeMs;
    await importPaths(directory, [{ git: repo }]);
    assert.deepEqual(await readFile(index), before);
    assert.equal((await stat(index)).mtimeMs, modified);
    git(repo, 'status', '--porcelain');
    assert.notDeepEqual(await readFile(index), before);
  },
);

test(
  'a repository with no commit, or a folder that is not a repository root, is refused',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    git(base, 'init', '-q', 'empty');
    await assert.rejects(
      importPaths(directory, [{ git: join(base, 'empty') }]),
      /has no commit to capture: HEAD names no commit yet/,
    );
    const repo = await repository(base, { 'src/a.txt': 'a\n' });
    await assert.rejects(
      importPaths(directory, [{ git: join(repo, 'src') }]),
      /is inside the repository .*; name its top-level folder/,
    );
    await assert.rejects(
      importPaths(directory, [{ git: join(repo, '.git') }]),
      /is a repository's Git directory; name its working folder/,
    );
    assert.deepEqual(
      await readdir(join(directory, '.sulai', 'occurrences')),
      [],
    );
  },
);

test(
  'a blob larger than one occurrence record is streamed, not buffered',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    git(base, 'init', '-q', 'repo');
    const repo = join(base, 'repo');
    // Larger than the 64 MiB any buffered read of Git's output is allowed, and
    // different at every offset of a chunk, so a boundary error changes the hash.
    const block = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < block.length; index += 1) {
      block[index] = (index * 31 + (index >>> 8)) & 0xff;
    }
    const expected = createHash('sha256');
    const handle = await open(join(repo, 'large.bin'), 'w');
    let byteLength = 0;
    try {
      for (let index = 0; index < 65; index += 1) {
        block[0] = index;
        await handle.write(block);
        expected.update(block);
        byteLength += block.length;
      }
      const tail = Buffer.from('ragged tail');
      await handle.write(tail);
      expected.update(tail);
      byteLength += tail.length;
    } finally {
      await handle.close();
    }
    git(repo, 'add', 'large.bin');
    git(repo, 'commit', '-q', '-m', 'large');
    const result = await importPaths(directory, [{ git: repo }]);
    const record = await inspectOccurrence(directory, result.occurrenceId);
    assert.deepEqual(
      record.entries.map((entry) => ({ ...entry })),
      [
        {
          root: 'r1',
          path: 'large.bin',
          artifact: `sha256:${expected.digest('hex')}`,
          byteLength,
          mode: '100644',
          blob: git(repo, 'rev-parse', 'HEAD:large.bin'),
          new: true,
        },
      ],
    );
  },
);

test(
  'inspect recomputes every blob ID from the preserved bytes',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, {
      'a.txt': 'alpha\n',
      'b.txt': 'beta\n',
    });
    const result = await importPaths(directory, [{ git: repo }]);
    await inspectProject(directory);
    // A record whose blob IDs are swapped is well formed, and wrong.
    const { id, ...occurrence } = await inspectOccurrence(
      directory,
      result.occurrenceId,
    );
    assert.equal(id, result.occurrenceId);
    const [a, b] = occurrence.entries.map(
      (entry) => 'blob' in entry && entry.blob,
    );
    const forged = encodeOccurrence({
      ...occurrence,
      entries: occurrence.entries.map((entry) => ({
        ...entry,
        blob: entry.path === 'a.txt' ? b : a,
      })),
    });
    await writeFile(
      join(directory, '.sulai', 'occurrences', `${forged.id.slice(-64)}.json`),
      forged.bytes,
    );
    const wrong =
      /records blob [0-9a-f]{40} at r1\/a\.txt, but its bytes are blob [0-9a-f]{40}/;
    await assert.rejects(inspectProject(directory), wrong);
    await assert.rejects(inspectOccurrence(directory, forged.id), wrong);
  },
);

test(
  'a citation into a Git root resolves exactly as one into a folder',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const notes = 'one\ntwo\nthree\n';
    const repo = await repository(base, { 'notes.md': notes });
    const copy = join(base, 'copy');
    await tree(copy, { 'notes.md': notes });
    const fromGit = await importPaths(directory, [{ git: repo }]);
    const fromFolder = await importPaths(directory, [copy]);
    const page = Buffer.from('The plan: `r1/notes.md#L2-L3`.\n');
    const first = await recordState(directory, page, fromGit.occurrenceId);
    const second = await recordState(directory, page, fromFolder.occurrenceId);
    assert.match(first.id, /^state:v3:/);
    assert.equal(second.parent, first.id);
    assert.deepEqual(
      (await inspectState(directory, first.id)).references,
      (await inspectState(directory, second.id)).references,
    );
    const [reference] = (await explainLine(directory, first.id, 1)).references;
    assert.ok(reference !== undefined && 'evidence' in reference);
    assert.equal(reference.evidence, 'two\nthree');
    assert.deepEqual(reference.where, {
      root: 'r1',
      locator: resolve(repo),
      commit: git(repo, 'rev-parse', 'HEAD'),
      path: 'notes.md',
    });
  },
);

test(
  'folder and Git roots number together, and may not overlap',
  { skip },
  async (t) => {
    const { base, directory } = await setup(t);
    const repo = await repository(base, { 'a.txt': 'a\n' });
    const notes = join(base, 'notes');
    await tree(notes, { 'n.md': 'n\n' });
    const run = spawnSync(
      process.execPath,
      [cli, 'import', directory, notes, '--git', repo],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const mixed = JSON.parse(run.stdout) as { roots: unknown[] };
    assert.deepEqual(mixed.roots, [
      { id: 'r1', source: 'filesystem', kind: 'directory', locator: notes },
      {
        id: 'r2',
        source: 'git',
        locator: repo,
        commit: git(repo, 'rev-parse', 'HEAD'),
        worktree: 'clean',
      },
    ]);
    const overlap =
      /Roots r1 and r2 overlap; a folder root cannot lie inside or contain a Git root's repository/;
    await assert.rejects(
      importPaths(directory, [repo, { git: repo }]),
      overlap,
    );
    await assert.rejects(
      importPaths(directory, [{ git: repo }, join(repo, 'a.txt')]),
      overlap,
    );
    await assert.rejects(
      importPaths(directory, [base, { git: repo }]),
      overlap,
    );
    await assert.rejects(
      importPaths(directory, [{ git: repo }, { git: repo }]),
      /Roots r1 and r2 are the same commit of the same repository/,
    );
  },
);
