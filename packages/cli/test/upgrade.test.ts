import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeOccurrence, encodeStateRevision } from '@sulai/core';
import {
  importPaths,
  initializeProject,
  inspectProject,
  projectStatus,
  recordState,
  upgradeProject,
} from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

const VERSION_4 = '{"format":"sulai.project","version":4}\n';
const VERSION_5 = '{"format":"sulai.project","version":5}\n';
const VERSION_6 = '{"format":"sulai.project","version":6}\n';

const hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * A store exactly as a version 4 build left it: version 1 records, written
 * here without the current code, under the version 4 marker.
 */
async function version4Store(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'sulai-upgrade-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, 'project');
  await initializeProject(directory);
  const store = join(directory, '.sulai');
  const notes = Buffer.from('alpha\nbeta\n');
  const page = Buffer.from('Start from `r1/notes.md#L1`.\n');
  for (const bytes of [notes, page]) {
    await writeFile(join(store, 'artifacts', `${hex(bytes)}.raw`), bytes);
  }
  const occurrence = encodeOccurrence({
    format: 'sulai.occurrence',
    version: 1,
    nonce: '0123456789abcdef0123456789abcdef',
    startedAt: '2026-01-02T03:04:05.006Z',
    finishedAt: '2026-01-02T03:04:06.007Z',
    status: 'complete',
    roots: [
      {
        id: 'r1',
        kind: 'directory',
        platform: process.platform,
        locator: resolve(base, 'notes'),
      },
    ],
    entries: [
      {
        root: 'r1',
        path: 'notes.md',
        artifact: `sha256:${hex(notes)}`,
        byteLength: notes.byteLength,
        modifiedAt: '2026-01-01T00:00:00.000Z',
        new: true,
      },
    ],
    skipped: [],
    excluded: [],
  });
  await writeFile(
    join(store, 'occurrences', `${occurrence.id.slice(-64)}.json`),
    occurrence.bytes,
  );
  const state = encodeStateRevision({
    format: 'sulai.state',
    version: 1,
    parent: null,
    createdAt: '2026-01-02T03:04:07.008Z',
    page: `sha256:${hex(page)}`,
    occurrence: occurrence.id,
    references: [
      {
        locator: 'r1/notes.md#L1',
        status: 'resolved',
        artifact: `sha256:${hex(notes)}`,
        startByte: 0,
        endByte: 5,
      },
    ],
  });
  await writeFile(
    join(store, 'states', `${state.id.slice(-64)}.json`),
    state.bytes,
  );
  await writeFile(join(store, 'project.json'), VERSION_4);
  return { base, directory, store, page, occurrence, state };
}

/** Every file in the store, by path, with its bytes. */
async function snapshot(store: string) {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(store, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(store, path), await readFile(path));
  }
  return files;
}

test('a version 4 store is refused until upgraded, and upgrading changes only the marker', async (t) => {
  const { base, directory, store, page, occurrence, state } =
    await version4Store(t);
  const before = await snapshot(store);
  const refused =
    /storage format version 4; this build requires version 6\. Upgrade it with `sulai upgrade`/;
  await assert.rejects(inspectProject(directory), refused);
  await assert.rejects(projectStatus(directory), refused);
  await assert.rejects(initializeProject(directory), refused);
  await assert.rejects(importPaths(directory, [base]), refused);
  assert.deepEqual(await snapshot(store), before);

  assert.deepEqual(await upgradeProject(directory), {
    directory,
    from: 4,
    to: 6,
    upgraded: true,
    verified: { artifacts: 2, occurrences: 1, states: 1 },
  });
  const after = await snapshot(store);
  assert.equal(after.get('project.json')?.toString('utf8'), VERSION_6);
  after.delete('project.json');
  before.delete('project.json');
  assert.deepEqual(after, before);

  // Every version 1 record reads as it is, and the history continues in
  // version 3 from where it stood.
  const inspection = await inspectProject(directory);
  assert.deepEqual(
    inspection.occurrences.map((item) => item.id),
    [occurrence.id],
  );
  assert.deepEqual(
    inspection.states.map((item) => item.id),
    [state.id],
  );
  const next = await recordState(directory, page, occurrence.id);
  assert.match(next.id, /^state:v3:/);
  assert.equal(next.parent, state.id);
  assert.deepEqual(await upgradeProject(directory), {
    directory,
    from: 6,
    to: 6,
    upgraded: false,
  });
});

test('the upgrade command verifies and upgrades in its own process', async (t) => {
  const { directory } = await version4Store(t);
  const refused = spawnSync(process.execPath, [cli, 'inspect', directory], {
    encoding: 'utf8',
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /sulai upgrade/);
  const upgraded = spawnSync(process.execPath, [cli, 'upgrade', directory], {
    encoding: 'utf8',
  });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.equal(
    (JSON.parse(upgraded.stdout) as { upgraded: boolean }).upgraded,
    true,
  );
  const inspected = spawnSync(process.execPath, [cli, 'inspect', directory], {
    encoding: 'utf8',
  });
  assert.equal(inspected.status, 0, inspected.stderr);
});

test('a corrupt version 4 store refuses the upgrade and keeps its version 4 marker', async (t) => {
  const { directory, store } = await version4Store(t);
  const notes = join(
    store,
    'artifacts',
    `${hex(Buffer.from('alpha\nbeta\n'))}.raw`,
  );
  // Same length, different bytes: only the hash can tell.
  await writeFile(notes, 'alphA\nbeta\n');
  await assert.rejects(upgradeProject(directory), /hash does not match/);
  assert.equal(await readFile(join(store, 'project.json'), 'utf8'), VERSION_4);
  assert.deepEqual(await readdir(join(store, 'tmp')), []);
});

test('a version 4 marker over records only a later version writes refuses the upgrade', async (t) => {
  const { base, directory, store } = await version4Store(t);
  const later = encodeOccurrence({
    format: 'sulai.occurrence',
    version: 2,
    nonce: 'fedcba9876543210fedcba9876543210',
    startedAt: '2026-01-03T00:00:00.000Z',
    finishedAt: '2026-01-03T00:00:00.000Z',
    status: 'complete',
    roots: [
      {
        id: 'r1',
        source: 'filesystem',
        kind: 'directory',
        platform: process.platform,
        locator: resolve(base, 'empty'),
      },
    ],
    entries: [],
    skipped: [],
    excluded: [],
  });
  await writeFile(
    join(store, 'occurrences', `${later.id.slice(-64)}.json`),
    later.bytes,
  );
  await assert.rejects(
    upgradeProject(directory),
    /marked version 4 but holds records only a later version writes/,
  );
  assert.equal(await readFile(join(store, 'project.json'), 'utf8'), VERSION_4);
});

test('versions before 4 cannot be upgraded', async (t) => {
  const { directory, store } = await version4Store(t);
  await writeFile(
    join(store, 'project.json'),
    '{"format":"sulai.project","version":3}\n',
  );
  await assert.rejects(
    upgradeProject(directory),
    /version 3; this build requires version 6\. Only versions 4 and 5 can be upgraded/,
  );
});

/** A version 5 store: the version 4 records, plus a version 2 occurrence and revision. */
async function version5Store(t: TestContext) {
  const store = await version4Store(t);
  const later = encodeOccurrence({
    format: 'sulai.occurrence',
    version: 2,
    nonce: 'fedcba9876543210fedcba9876543210',
    startedAt: '2026-01-03T00:00:00.000Z',
    finishedAt: '2026-01-03T00:00:00.000Z',
    status: 'complete',
    roots: [
      {
        id: 'r1',
        source: 'filesystem',
        kind: 'directory',
        platform: process.platform,
        locator: resolve(store.base, 'empty'),
      },
    ],
    entries: [],
    skipped: [],
    excluded: [],
  });
  await writeFile(
    join(store.store, 'occurrences', `${later.id.slice(-64)}.json`),
    later.bytes,
  );
  const revision = encodeStateRevision({
    format: 'sulai.state',
    version: 2,
    parent: store.state.id,
    createdAt: '2026-01-03T00:00:01.000Z',
    page: `sha256:${hex(store.page)}`,
    occurrence: later.id,
    references: [
      {
        locator: 'r1/notes.md#L1',
        status: 'unresolved',
        reason: 'path-not-in-occurrence',
      },
    ],
  });
  await writeFile(
    join(store.store, 'states', `${revision.id.slice(-64)}.json`),
    revision.bytes,
  );
  await writeFile(join(store.store, 'project.json'), VERSION_5);
  return { ...store, later, revision };
}

test('a version 5 store is refused until upgraded, and upgrading changes only the marker', async (t) => {
  const { directory, store, page, later, revision } = await version5Store(t);
  const before = await snapshot(store);
  await assert.rejects(
    projectStatus(directory),
    /storage format version 5; this build requires version 6\. Upgrade it with `sulai upgrade`/,
  );
  assert.deepEqual(await upgradeProject(directory), {
    directory,
    from: 5,
    to: 6,
    upgraded: true,
    verified: { artifacts: 2, occurrences: 2, states: 2 },
  });
  const after = await snapshot(store);
  assert.equal(after.get('project.json')?.toString('utf8'), VERSION_6);
  after.delete('project.json');
  before.delete('project.json');
  assert.deepEqual(after, before);
  // The history continues in version 3 from the version 2 head.
  const next = await recordState(directory, page, later.id);
  assert.match(next.id, /^state:v3:/);
  assert.equal(next.parent, revision.id);
});

test('a version 5 marker over a record only version 6 writes refuses the upgrade', async (t) => {
  const { base, directory, store } = await version5Store(t);
  const newer = encodeOccurrence({
    format: 'sulai.occurrence',
    version: 3,
    nonce: '00112233445566778899aabbccddeeff',
    startedAt: '2026-01-04T00:00:00.000Z',
    finishedAt: '2026-01-04T00:00:00.000Z',
    status: 'complete',
    roots: [
      {
        id: 'r1',
        source: 'filesystem',
        kind: 'directory',
        platform: process.platform,
        locator: resolve(base, 'empty'),
      },
    ],
    entries: [],
    skipped: [],
    excluded: [],
  });
  await writeFile(
    join(store, 'occurrences', `${newer.id.slice(-64)}.json`),
    newer.bytes,
  );
  await assert.rejects(
    upgradeProject(directory),
    /marked version 5 but holds records only a later version writes/,
  );
  assert.equal(await readFile(join(store, 'project.json'), 'utf8'), VERSION_5);
});
