/**
 * Acquisition: checking the roots a caller names, walking them without following
 * links, preserving every input, and recording the attempt as one occurrence.
 */
import { randomBytes } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { encodeOccurrence, ValidationError } from '@sulai/core';
import type {
  ArtifactId,
  OccurrenceEntry,
  OccurrenceExclusion,
  OccurrenceSkip,
  SkipReason,
} from '@sulai/core';
import { occurrencePath } from './occurrences.js';
import { loadProject } from './project.js';
import {
  InputUnavailable,
  artifactPath,
  cleanupAfterFailure,
  hasCode,
  openRegularFile,
  publishArtifact,
  removeTemporaryFile,
  stageFromHandle,
  writeImmutable,
} from './store.js';
import type { StagedArtifact } from './store.js';

/** Why an input that was listed could not be opened, or null for a real fault. */
function openFailure(error: unknown): SkipReason | null {
  if (hasCode(error, 'ENOENT')) return 'vanished';
  if (hasCode(error, 'EACCES', 'EPERM', 'EBUSY')) return 'unreadable';
  // It was a regular file when listed; a link or anything else now means it
  // changed between being listed and being opened.
  if (hasCode(error, 'ELOOP', 'ENOTDIR') || error instanceof ValidationError) {
    return 'changed-during-read';
  }
  return null;
}

function listFailure(error: unknown): SkipReason | null {
  if (hasCode(error, 'ENOENT')) return 'vanished';
  if (hasCode(error, 'EACCES', 'EPERM')) return 'unreadable';
  if (hasCode(error, 'ENOTDIR')) return 'changed-during-read';
  return null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function byUtf8Path(a: { path: string }, b: { path: string }): number {
  return Buffer.compare(
    Buffer.from(a.path, 'utf8'),
    Buffer.from(b.path, 'utf8'),
  );
}

/** Whether `child` is `parent` itself or lies inside it. */
function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

interface CheckedRoot {
  readonly id: string;
  readonly kind: 'file' | 'directory';
  readonly locator: string;
  readonly real: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

const sameDirectory = (
  a: { dev: bigint; ino: bigint },
  b: { dev: bigint; ino: bigint },
) => a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;

/**
 * Checks every root before anything is captured, so a root that is missing, a
 * link, not a file or directory, inside the project store, or overlapping
 * another root refuses the whole acquisition and nothing is recorded. The v1
 * record has no way to state that a named root was absent, and an acquisition
 * that silently dropped one would misstate what was chosen.
 */
async function checkRoots(
  inputs: readonly string[],
  storePath: string,
): Promise<CheckedRoot[]> {
  if (inputs.length === 0) {
    throw new ValidationError('Name at least one path to import');
  }
  const roots: CheckedRoot[] = [];
  for (const [index, input] of inputs.entries()) {
    const locator = resolve(input);
    if (isWithin(storePath, locator)) {
      throw new ValidationError('Cannot acquire from inside the project store');
    }
    const stat = await lstat(locator, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new ValidationError('The input must not be a symbolic link');
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new ValidationError(
        'The input must be a regular file or a directory',
      );
    }
    roots.push({
      id: `r${index + 1}`,
      kind: stat.isFile() ? 'file' : 'directory',
      locator,
      // Compared by real path, so a root reached through a linked ancestor
      // is still recognized as the same place.
      real: await realpath(locator),
      dev: stat.dev,
      ino: stat.ino,
    });
  }
  for (const a of roots) {
    for (const b of roots) {
      if (a === b) continue;
      const overlaps =
        (a.kind === 'directory' && isWithin(a.real, b.real)) ||
        (a.kind === 'directory' &&
          b.kind === 'directory' &&
          sameDirectory(a, b)) ||
        (a.kind === 'file' && b.kind === 'file' && a.real === b.real);
      if (overlaps) {
        throw new ValidationError(
          `Roots ${a.id} and ${b.id} overlap; every input must belong to exactly one root`,
        );
      }
    }
  }
  return roots;
}

/**
 * Preserves files, or every file under directories, from one or more roots and
 * records the attempt as one import occurrence. Roots are numbered `r1`, `r2`
 * and so on in the order given.
 *
 * Only the named roots are read. Symbolic links and junctions are never
 * followed, and no content is read for references to anything else, so an
 * acquisition never reaches outside what the caller chose. The project's own
 * store is excluded in whichever root contains it. An input that cannot be
 * captured is recorded as skipped with a reason and the rest continues; a
 * failure of the store, or a root that cannot be listed at all, stops the
 * acquisition. Every artifact is published before the occurrence, so an
 * occurrence never names bytes the store does not hold.
 *
 * The walk is not atomic. Inputs that appear during it may be missed, and a
 * complete occurrence means that everything the walk found was captured, not
 * that the result is a snapshot of one instant.
 */
export async function importPaths(
  directory: string,
  inputs: readonly string[],
) {
  const project = await loadProject(directory);
  const roots = await checkRoots(inputs, project.store);
  const store = await lstat(project.store, { bigint: true });
  const isStore = (stat: { dev: bigint; ino: bigint }, path: string) =>
    sameDirectory(stat, store) || relative(project.store, path) === '';
  const otherRoot = (stat: { dev: bigint; ino: bigint }, root: string) =>
    roots.find(
      (other) =>
        other.id !== root &&
        other.kind === 'directory' &&
        sameDirectory(stat, other),
    );

  const startedAt = new Date().toISOString();
  const nonce = randomBytes(16).toString('hex');
  const entries: OccurrenceEntry[] = [];
  const skipped: OccurrenceSkip[] = [];
  const excluded: OccurrenceExclusion[] = [];
  const isNew = new Map<ArtifactId, boolean>();

  async function capture(
    root: string,
    absolute: string,
    path: string,
  ): Promise<void> {
    let source: FileHandle;
    try {
      source = await openRegularFile(absolute);
    } catch (error) {
      const reason = openFailure(error);
      if (reason === null) throw error;
      skipped.push({ root, path, reason });
      return;
    }
    let staged: StagedArtifact;
    try {
      staged = await stageFromHandle(project.temporary, source);
    } catch (error) {
      if (!(error instanceof InputUnavailable)) throw error;
      skipped.push({ root, path, reason: error.reason });
      return;
    } finally {
      await source.close();
    }
    let created: boolean;
    try {
      created = await publishArtifact(
        staged,
        artifactPath(project.artifacts, staged.id),
      );
    } catch (error) {
      throw await cleanupAfterFailure(error, staged.temporaryPath);
    }
    await removeTemporaryFile(staged.temporaryPath);
    // The first capture of these bytes in this acquisition decides whether the
    // acquisition added them; a later duplicate, under any root, did not find
    // them already there.
    const added = isNew.get(staged.id) ?? created;
    isNew.set(staged.id, added);
    entries.push({
      root,
      path,
      artifact: staged.id,
      byteLength: staged.byteLength,
      modifiedAt: staged.modifiedAt,
      new: added,
    });
  }

  async function walk(
    root: string,
    absolute: string,
    path: string,
  ): Promise<void> {
    let names: Buffer[];
    try {
      names = await readdir(absolute, { encoding: 'buffer' });
    } catch (error) {
      const reason = listFailure(error);
      if (reason === null || path === '') throw error;
      skipped.push({ root, path, reason });
      return;
    }
    names.sort(Buffer.compare);
    for (const raw of names) {
      let name: string;
      try {
        name = utf8.decode(raw);
      } catch {
        const lossy = raw.toString('utf8');
        skipped.push({
          root,
          path: path === '' ? lossy : `${path}/${lossy}`,
          reason: 'non-utf8-name',
        });
        continue;
      }
      const child = join(absolute, name);
      const childPath = path === '' ? name : `${path}/${name}`;
      let stat;
      try {
        stat = await lstat(child, { bigint: true });
      } catch (error) {
        const reason = listFailure(error);
        if (reason === null) throw error;
        skipped.push({ root, path: childPath, reason });
        continue;
      }
      if (stat.isSymbolicLink()) {
        skipped.push({ root, path: childPath, reason: 'symbolic-link' });
      } else if (stat.isDirectory()) {
        if (isStore(stat, child)) {
          excluded.push({ root, path: childPath, reason: 'project-store' });
          continue;
        }
        const overlapping = otherRoot(stat, root);
        if (overlapping !== undefined) {
          // Paths said the roots were apart; the filesystem says otherwise.
          throw new ValidationError(
            `Roots ${root} and ${overlapping.id} overlap; every input must belong to exactly one root`,
          );
        }
        await walk(root, child, childPath);
      } else if (stat.isFile()) {
        await capture(root, child, childPath);
      } else {
        skipped.push({ root, path: childPath, reason: 'not-regular-file' });
      }
    }
  }

  for (const root of roots) {
    if (root.kind === 'file') await capture(root.id, root.locator, '');
    else await walk(root.id, root.locator, '');
  }

  const order = new Map(roots.map((root, index) => [root.id, index]));
  const byRootThenPath = (
    a: { root: string; path: string },
    b: { root: string; path: string },
  ) => (order.get(a.root) ?? 0) - (order.get(b.root) ?? 0) || byUtf8Path(a, b);
  entries.sort(byRootThenPath);
  skipped.sort(byRootThenPath);
  excluded.sort(byRootThenPath);
  const { id, bytes, occurrence } = encodeOccurrence({
    format: 'sulai.occurrence',
    version: 1,
    nonce,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: skipped.length === 0 ? 'complete' : 'partial',
    roots: roots.map((root) => ({
      id: root.id,
      kind: root.kind,
      platform: process.platform,
      locator: root.locator,
    })),
    entries,
    skipped,
    excluded,
  });
  // Published last, and never replacing anything: until this link exists the
  // acquisition has no record, and the artifacts it stored are only unreferenced.
  await writeImmutable(
    project.temporary,
    occurrencePath(project.occurrences, id),
    bytes,
  );
  const distinct = [...isNew.values()];
  return {
    occurrenceId: id,
    status: occurrence.status,
    roots: roots.map(({ id: root, kind, locator }) => ({
      id: root,
      kind,
      locator,
    })),
    entryCount: occurrence.entries.length,
    newArtifacts: distinct.filter(Boolean).length,
    existingArtifacts: distinct.filter((added) => !added).length,
    skipped: occurrence.skipped.map(({ root, path, reason }) => ({
      root,
      path,
      reason,
    })),
    excluded: occurrence.excluded.map(({ root, path, reason }) => ({
      root,
      path,
      reason,
    })),
  };
}

/** One root; see `importPaths`. */
export function importPath(directory: string, input: string) {
  return importPaths(directory, [input]);
}
