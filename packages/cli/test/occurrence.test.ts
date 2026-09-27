import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { encodeOccurrence, parseOccurrence } from '@sulai/core';
import {
  importPath,
  importPaths,
  initializeProject,
  inspectOccurrence,
  inspectProject,
} from '../dist/project.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const posix = process.platform !== 'win32';

async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sulai-occurrence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function tree(root: string, files: Record<string, string | Buffer>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

const sha = (content: string | Buffer) =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`;

async function project(t: TestContext) {
  const base = await temporary(t);
  const directory = join(base, 'project');
  const root = join(base, 'input');
  await initializeProject(directory);
  await mkdir(root);
  return { base, directory, root };
}

async function occurrenceFiles(directory: string) {
  return readdir(join(directory, '.sulai', 'occurrences'));
}

async function temporaryEntries(directory: string) {
  try {
    return await readdir(join(directory, '.sulai', 'tmp'));
  } catch {
    return [];
  }
}

function mockOnce<T extends keyof typeof fs>(
  t: TestContext,
  name: T,
  implementation: (...args: never[]) => unknown,
) {
  const mocked = t.mock.method(fs, name, implementation as never);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return mocked;
}

test('a directory acquisition answers which inputs, which bytes, which were new, and which event', async (t) => {
  const { directory, root } = await project(t);
  const files = {
    'b.txt': 'bravo',
    'a.txt': 'alpha',
    'a-c.txt': 'charlie',
    'a/inner.txt': 'delta',
    'nested/deep/c.bin': Buffer.from([0x00, 0xff, 0x0d, 0x0a]),
    'empty.bin': '',
    'copy-of-a.txt': 'alpha',
    'café.txt': 'echo',
  };
  await tree(root, files);
  const result = await importPath(directory, root);
  assert.equal(result.status, 'complete');
  assert.equal(result.entryCount, 8);
  assert.equal(result.newArtifacts, 7);
  assert.equal(result.existingArtifacts, 0);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.roots, [
    { id: 'r1', kind: 'directory', locator: resolve(root) },
  ]);

  const record = await inspectOccurrence(directory, result.occurrenceId);
  // Every input once, relative and `/`-separated, ordered by UTF-8 bytes (so
  // `a-c.txt` sorts before `a/inner.txt`), each with the hash of its own bytes.
  const expected = Object.keys(files).sort((x, y) =>
    Buffer.compare(Buffer.from(x), Buffer.from(y)),
  );
  assert.deepEqual(
    record.entries.map((entry) => entry.path),
    expected,
  );
  for (const entry of record.entries) {
    const content = files[entry.path as keyof typeof files];
    assert.equal(entry.artifact, sha(content), entry.path);
    assert.equal(entry.byteLength, Buffer.byteLength(content), entry.path);
    assert.equal(entry.new, true, entry.path);
    assert.equal(entry.root, 'r1');
  }
  assert.deepEqual(record.roots, [
    {
      id: 'r1',
      kind: 'directory',
      platform: process.platform,
      locator: resolve(root),
    },
  ]);
  assert.ok(record.startedAt <= record.finishedAt);

  // The record is stored under the hash of its own bytes, and the only
  // absolute path in it is the root's locator.
  const [name] = await occurrenceFiles(directory);
  const bytes = await readFile(
    join(directory, '.sulai', 'occurrences', name as string),
  );
  assert.equal(`occurrence:v1:${name?.slice(0, 64)}`, result.occurrenceId);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    name?.slice(0, 64),
  );
  const escapedBase = JSON.stringify(resolve(root, '..')).slice(1, -1);
  assert.equal(bytes.toString('utf8').split(escapedBase).length - 1, 1);
  assert.deepEqual(parseOccurrence(bytes).entries, record.entries);

  const inspection = await inspectProject(directory);
  assert.equal(inspection.artifacts.length, 7);
  assert.deepEqual(
    inspection.occurrences.map(({ id, status, entries, skipped }) => ({
      id,
      status,
      entries,
      skipped,
    })),
    [{ id: result.occurrenceId, status: 'complete', entries: 8, skipped: 0 }],
  );
  assert.deepEqual(await temporaryEntries(directory), []);
});

test('the same bytes acquired again are a new event, and a changed file is a new version of its path', async (t) => {
  const { directory, root } = await project(t);
  await tree(root, { 'log.jsonl': '{"n":1}\n', 'fixed.txt': 'unchanged' });
  const first = await importPath(directory, root);
  const again = await importPath(directory, root);
  assert.notEqual(again.occurrenceId, first.occurrenceId);
  assert.equal(again.newArtifacts, 0);
  assert.equal(again.existingArtifacts, 2);
  assert.ok(
    (await inspectOccurrence(directory, again.occurrenceId)).entries.every(
      (entry) => entry.new === false,
    ),
  );

  await writeFile(join(root, 'log.jsonl'), '{"n":1}\n{"n":2}\n');
  const grown = await importPath(directory, root);
  assert.equal(grown.newArtifacts, 1);
  assert.equal(grown.existingArtifacts, 1);
  const before = await inspectOccurrence(directory, first.occurrenceId);
  const after = await inspectOccurrence(directory, grown.occurrenceId);
  const artifactOf = (record: typeof before, path: string) =>
    record.entries.find((entry) => entry.path === path)?.artifact;
  assert.notEqual(
    artifactOf(before, 'log.jsonl'),
    artifactOf(after, 'log.jsonl'),
  );
  assert.equal(artifactOf(before, 'fixed.txt'), artifactOf(after, 'fixed.txt'));
  assert.equal((await inspectProject(directory)).occurrences.length, 3);
});

test('a single file is a one-entry occurrence at the root itself', async (t) => {
  const { directory, root } = await project(t);
  const file = join(root, 'one.txt');
  await writeFile(file, 'single');
  const result = await importPath(directory, file);
  assert.equal(result.entryCount, 1);
  assert.deepEqual(result.roots, [
    { id: 'r1', kind: 'file', locator: resolve(file) },
  ]);
  const record = await inspectOccurrence(directory, result.occurrenceId);
  assert.deepEqual(
    record.entries.map(({ path, artifact, new: added }) => ({
      path,
      artifact,
      added,
    })),
    [{ path: '', artifact: sha('single'), added: true }],
  );
  // Acquiring the same bytes from another place records the new place and
  // reports the bytes as already stored.
  await writeFile(join(root, 'elsewhere.txt'), 'single');
  const elsewhere = await importPath(directory, join(root, 'elsewhere.txt'));
  assert.equal(elsewhere.newArtifacts, 0);
  assert.equal(elsewhere.existingArtifacts, 1);
});

test('links are recorded and never followed, so nothing outside the chosen root is read', async (t) => {
  const { base, directory, root } = await project(t);
  const outside = join(base, 'outside');
  const secret = 'SYNTHETIC_OUTSIDE_SECRET';
  await tree(outside, { 'secret.txt': secret });
  await tree(root, { 'inside.txt': 'inside' });
  await symlink(
    outside,
    join(root, 'linked-directory'),
    posix ? 'dir' : 'junction',
  );
  let fileLink = true;
  try {
    await symlink(
      join(outside, 'secret.txt'),
      join(root, 'linked-file'),
      'file',
    );
  } catch (error) {
    // Windows allows file symbolic links only with a privilege; junctions do
    // not need one, so the directory case above always runs.
    if (posix) throw error;
    fileLink = false;
  }
  const result = await importPath(directory, root);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.skipped, [
    { root: 'r1', path: 'linked-directory', reason: 'symbolic-link' },
    ...(fileLink
      ? [{ root: 'r1', path: 'linked-file', reason: 'symbolic-link' }]
      : []),
  ]);
  const inspection = await inspectProject(directory);
  assert.deepEqual(
    inspection.artifacts.map((artifact) => artifact.id),
    [sha('inside')],
  );
  assert.equal(
    inspection.artifacts.some((artifact) => artifact.id === sha(secret)),
    false,
  );
});

test('an input that changes while it is read is skipped, and the rest is preserved', async (t) => {
  const { directory, root } = await project(t);
  await tree(root, {
    'growing.jsonl': 'x'.repeat(64),
    'settled.txt': 'settled',
  });
  const growing = join(root, 'growing.jsonl');
  const originalOpen = fs.open;
  mockOnce(t, 'open', (async (path: string, ...rest: unknown[]) => {
    const handle = await (
      originalOpen as (
        ...a: unknown[]
      ) => Promise<Awaited<ReturnType<typeof fs.open>>>
    )(path, ...rest);
    if (String(path) !== growing) return handle;
    const originalStat = handle.stat.bind(handle);
    (handle as unknown as { stat: () => Promise<unknown> }).stat = async () => {
      const observed = await originalStat();
      return Object.create(observed, {
        size: { value: observed.size - 1 },
      }) as unknown;
    };
    return handle;
  }) as never);
  const result = await importPath(directory, root);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.skipped, [
    { root: 'r1', path: 'growing.jsonl', reason: 'changed-during-read' },
  ]);
  assert.equal(result.entryCount, 1);
  assert.deepEqual(
    (await inspectProject(directory)).artifacts.map((artifact) => artifact.id),
    [sha('settled')],
  );
  assert.deepEqual(await temporaryEntries(directory), []);
});

test('the project store inside the root is excluded, and the store itself cannot be a root', async (t) => {
  const base = await temporary(t);
  await initializeProject(base);
  await tree(base, { 'notes.txt': 'notes', 'sub/more.txt': 'more' });
  const result = await importPath(base, base);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.excluded, [
    { root: 'r1', path: '.sulai', reason: 'project-store' },
  ]);
  assert.equal(result.entryCount, 2);
  await assert.rejects(
    importPath(base, join(base, '.sulai')),
    /inside the project store/,
  );
  await assert.rejects(
    importPath(base, join(base, '.sulai', 'artifacts')),
    /inside the project store/,
  );
});

test('a root that is a link, or missing, records nothing', async (t) => {
  const { base, directory, root } = await project(t);
  await symlink(root, join(base, 'root-link'), posix ? 'dir' : 'junction');
  await assert.rejects(
    importPath(directory, join(base, 'root-link')),
    /symbolic link/,
  );
  await assert.rejects(importPath(directory, join(base, 'missing')), {
    code: 'ENOENT',
  });
  assert.deepEqual(await occurrenceFiles(directory), []);
});

test('artifacts are published before the occurrence, so a failed record leaves no dangling reference', async (t) => {
  const { directory, root } = await project(t);
  await tree(root, { 'kept.txt': 'kept' });
  const originalLink = fs.link;
  const occurrences = `${sep}occurrences${sep}`;
  mockOnce(t, 'link', (async (from: string, to: string) => {
    if (String(to).includes(occurrences)) {
      throw Object.assign(new Error('Synthetic record failure'), {
        code: 'ENOSPC',
      });
    }
    return originalLink(from, to);
  }) as never);
  await assert.rejects(importPath(directory, root), /Synthetic record failure/);
  const inspection = await inspectProject(directory);
  assert.deepEqual(inspection.occurrences, []);
  assert.deepEqual(
    inspection.artifacts.map((artifact) => artifact.id),
    [sha('kept')],
  );
  assert.deepEqual(await temporaryEntries(directory), []);
});

test('a failure of the store stops the acquisition instead of being recorded as a skipped input', async (t) => {
  const { directory, root } = await project(t);
  await tree(root, { 'a.txt': 'a' });
  mockOnce(t, 'link', (async () => {
    throw Object.assign(new Error('Synthetic store failure'), {
      code: 'ENOSPC',
    });
  }) as never);
  await assert.rejects(importPath(directory, root), /Synthetic store failure/);
  assert.deepEqual(await occurrenceFiles(directory), []);
});

test('concurrent acquisitions are separate events that agree on which one added each artifact', async (t) => {
  const { directory, root } = await project(t);
  await tree(
    root,
    Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, `content ${i}`]),
    ),
  );
  const results = await Promise.all([
    importPath(directory, root),
    importPath(directory, root),
  ]);
  assert.notEqual(results[0]?.occurrenceId, results[1]?.occurrenceId);
  const records = await Promise.all(
    results.map((result) => inspectOccurrence(directory, result.occurrenceId)),
  );
  for (let index = 0; index < 12; index += 1) {
    const added = records.filter((record) => record.entries[index]?.new).length;
    assert.equal(added, 1, `f${index}`);
  }
});

test('inspection refuses a corrupt, non-canonical, or dangling occurrence and stray entries', async (t) => {
  const { directory, root } = await project(t);
  await tree(root, { 'a.txt': 'a' });
  const { occurrenceId } = await importPath(directory, root);
  const store = join(directory, '.sulai', 'occurrences');
  const file = join(
    store,
    `${occurrenceId.slice('occurrence:v1:'.length)}.json`,
  );
  const original = await readFile(file);

  const flipped = Buffer.from(original);
  flipped[10] = flipped[10] === 0x41 ? 0x42 : 0x41;
  await writeFile(file, flipped);
  await assert.rejects(
    inspectProject(directory),
    /occurrence hash does not match/,
  );
  await assert.rejects(
    inspectOccurrence(directory, occurrenceId),
    /occurrence hash does not match/,
  );
  await writeFile(file, original);

  // Stored under its own hash, so only its form is wrong.
  const pretty = Buffer.from(
    `${JSON.stringify(JSON.parse(original.toString('utf8')), null, 1)}\n`,
  );
  const prettyName = join(
    store,
    `${createHash('sha256').update(pretty).digest('hex')}.json`,
  );
  await writeFile(prettyName, pretty);
  await assert.rejects(inspectProject(directory), /canonical form/);
  await rm(prettyName);

  const record = parseOccurrence(original);
  for (const [entry, reason] of [
    [{ ...record.entries[0], artifact: sha('never stored') }, /not stored/],
    [
      { ...record.entries[0], byteLength: 99 },
      /disagrees with the stored artifact size/,
    ],
  ] as const) {
    const dangling = encodeOccurrence({ ...record, entries: [entry] });
    const danglingName = join(
      store,
      `${dangling.id.slice('occurrence:v1:'.length)}.json`,
    );
    await writeFile(danglingName, dangling.bytes);
    await assert.rejects(inspectProject(directory), reason);
    await assert.rejects(inspectOccurrence(directory, dangling.id), reason);
    await rm(danglingName);
  }

  await writeFile(join(store, 'stray'), 'synthetic');
  await assert.rejects(
    inspectProject(directory),
    /Unexpected entry in the occurrence store/,
  );
  await rm(join(store, 'stray'));
  assert.equal((await inspectProject(directory)).occurrences.length, 1);
});

test(
  'a name that is not valid UTF-8 is recorded as skipped',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const { directory, root } = await project(t);
    await writeFile(
      Buffer.concat([Buffer.from(`${root}/bad-`), Buffer.from([0xff])]),
      'x',
    );
    await tree(root, { 'good.txt': 'good' });
    const result = await importPath(directory, root);
    assert.deepEqual(result.skipped, [
      { root: 'r1', path: 'bad-�', reason: 'non-utf8-name' },
    ]);
    assert.equal(result.entryCount, 1);
  },
);

test(
  'unreadable files and directories, and special files, are recorded as skipped',
  {
    skip: !posix || process.getuid?.() === 0,
  },
  async (t) => {
    const { directory, root } = await project(t);
    await tree(root, {
      'locked.txt': 'locked',
      'closed/inner.txt': 'inner',
      'open.txt': 'open',
    });
    const fifo = spawnSync('mkfifo', [join(root, 'pipe')]);
    const expected = [
      { root: 'r1', path: 'closed', reason: 'unreadable' },
      { root: 'r1', path: 'locked.txt', reason: 'unreadable' },
      ...(fifo.status === 0
        ? [{ root: 'r1', path: 'pipe', reason: 'not-regular-file' }]
        : []),
    ];
    await chmod(join(root, 'locked.txt'), 0o000);
    await chmod(join(root, 'closed'), 0o000);
    // Restored here, before the test returns, because the temporary directory
    // is removed by a hook registered earlier, and a recursive removal cannot
    // list a directory that is still mode 000.
    let result;
    try {
      result = await importPath(directory, root);
    } finally {
      await chmod(join(root, 'closed'), 0o700);
      await chmod(join(root, 'locked.txt'), 0o600);
    }
    assert.deepEqual(result.skipped, expected);
    assert.equal(result.entryCount, 1);
  },
);

test('the CLI reports a partial acquisition with its record and a distinct exit status', async (t) => {
  const { base, directory, root } = await project(t);
  await tree(root, { 'inside.txt': 'inside' });
  function run(args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  }
  const complete = run(['import', directory, root]);
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(complete.stderr, '');
  assert.equal(
    (JSON.parse(complete.stdout) as { status: string }).status,
    'complete',
  );

  await tree(base, { 'outside/x.txt': 'x' });
  await symlink(
    join(base, 'outside'),
    join(root, 'link'),
    posix ? 'dir' : 'junction',
  );
  const partial = run(['import', directory, root]);
  assert.equal(partial.status, 3);
  assert.match(
    partial.stderr,
    /partial acquisition: 1 input\(s\) could not be captured/,
  );
  const printed = JSON.parse(partial.stdout) as {
    occurrenceId: string;
    status: string;
    skipped: unknown[];
  };
  assert.equal(printed.status, 'partial');
  assert.deepEqual(printed.skipped, [
    { root: 'r1', path: 'link', reason: 'symbolic-link' },
  ]);
  const shown = run(['inspect', directory, printed.occurrenceId]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(
    (JSON.parse(shown.stdout) as { id: string }).id,
    printed.occurrenceId,
  );
});

test('one acquisition across several roots is one occurrence, numbered in argument order', async (t) => {
  const { base, directory } = await project(t);
  const first = join(base, 'first');
  const second = join(base, 'second');
  const single = join(base, 'single.txt');
  await tree(first, { 'b.txt': 'shared', 'only-first.txt': 'first' });
  await tree(second, { 'a.txt': 'shared', 'only-second.txt': 'second' });
  await writeFile(single, 'single');
  const result = await importPaths(directory, [first, second, single]);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.roots, [
    { id: 'r1', kind: 'directory', locator: resolve(first) },
    { id: 'r2', kind: 'directory', locator: resolve(second) },
    { id: 'r3', kind: 'file', locator: resolve(single) },
  ]);
  // Identical bytes under two roots are one artifact and two entries.
  assert.equal(result.entryCount, 5);
  assert.equal(result.newArtifacts, 4);
  const record = await inspectOccurrence(directory, result.occurrenceId);
  assert.deepEqual(
    record.entries.map(({ root, path, artifact, new: added }) => ({
      root,
      path,
      artifact,
      added,
    })),
    [
      { root: 'r1', path: 'b.txt', artifact: sha('shared'), added: true },
      {
        root: 'r1',
        path: 'only-first.txt',
        artifact: sha('first'),
        added: true,
      },
      { root: 'r2', path: 'a.txt', artifact: sha('shared'), added: true },
      {
        root: 'r2',
        path: 'only-second.txt',
        artifact: sha('second'),
        added: true,
      },
      { root: 'r3', path: '', artifact: sha('single'), added: true },
    ],
  );
  assert.equal((await inspectProject(directory)).occurrences.length, 1);

  // The order given is the order recorded.
  const swapped = await importPaths(directory, [second, first]);
  assert.deepEqual(
    swapped.roots.map(({ id, locator }) => [id, locator]),
    [
      ['r1', resolve(second)],
      ['r2', resolve(first)],
    ],
  );
  assert.equal(swapped.newArtifacts, 0);
});

test('overlapping roots are refused before anything is captured', async (t) => {
  const { base, directory, root } = await project(t);
  await tree(root, { 'sub/inner.txt': 'inner', 'file.txt': 'file' });
  const overlapping = [
    [root, root],
    [root, join(root, 'sub')],
    [join(root, 'sub'), root],
    [root, join(root, 'file.txt')],
    [root, join(root, 'sub', '..')],
    [join(root, 'file.txt'), join(root, 'sub', '..', 'file.txt')],
  ];
  for (const inputs of overlapping) {
    await assert.rejects(
      importPaths(directory, inputs),
      /overlap; every input must belong to exactly one root/,
      inputs.join(' + '),
    );
  }
  // Also when one root is named through a linked ancestor of the other.
  await symlink(root, join(base, 'alias'), posix ? 'dir' : 'junction');
  await assert.rejects(
    importPaths(directory, [join(base, 'alias', 'sub'), root]),
    /overlap/,
  );
  const inspection = await inspectProject(directory);
  assert.deepEqual(inspection.artifacts, []);
  assert.deepEqual(inspection.occurrences, []);
});

test('a missing or linked root refuses the whole acquisition, even after an available one', async (t) => {
  const { base, directory, root } = await project(t);
  await tree(root, { 'kept.txt': 'kept' });
  await assert.rejects(importPaths(directory, [root, join(base, 'missing')]), {
    code: 'ENOENT',
  });
  await symlink(root, join(base, 'link'), posix ? 'dir' : 'junction');
  await assert.rejects(
    importPaths(directory, [root, join(base, 'link')]),
    /symbolic link/,
  );
  await assert.rejects(importPaths(directory, []), /at least one path/);
  // Checked before capture, so not even the available root was stored.
  const inspection = await inspectProject(directory);
  assert.deepEqual(inspection.artifacts, []);
  assert.deepEqual(inspection.occurrences, []);
});

test('the project store is excluded in whichever root contains it, and skips name their root', async (t) => {
  const base = await temporary(t);
  const directory = join(base, 'project');
  const other = join(base, 'other');
  await initializeProject(directory);
  await tree(directory, { 'notes.txt': 'notes' });
  await tree(other, { 'o.txt': 'other' });
  await tree(base, { 'elsewhere/x.txt': 'x' });
  await symlink(
    join(base, 'elsewhere'),
    join(other, 'link'),
    posix ? 'dir' : 'junction',
  );
  const result = await importPaths(directory, [other, directory]);
  assert.deepEqual(result.excluded, [
    { root: 'r2', path: '.sulai', reason: 'project-store' },
  ]);
  assert.deepEqual(result.skipped, [
    { root: 'r1', path: 'link', reason: 'symbolic-link' },
  ]);
  assert.equal(result.status, 'partial');
  assert.equal(result.entryCount, 2);
});

test('the CLI takes several paths as one acquisition', async (t) => {
  const { base, directory } = await project(t);
  await tree(base, { 'one/a.txt': 'a', 'two/b.txt': 'b' });
  const result = spawnSync(
    process.execPath,
    [cli, 'import', directory, join(base, 'one'), join(base, 'two')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout) as {
    roots: { id: string }[];
    entryCount: number;
  };
  assert.deepEqual(
    printed.roots.map((root) => root.id),
    ['r1', 'r2'],
  );
  assert.equal(printed.entryCount, 2);
  assert.equal((await occurrenceFiles(directory)).length, 1);
});
