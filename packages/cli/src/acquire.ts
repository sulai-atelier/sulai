/**
 * Acquisition: checking the roots a caller names, walking folders without
 * following links, reading one commit of a repository or observing its working
 * tree, preserving every input, and recording the attempt as one occurrence.
 */
import { randomBytes } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GIT_BLOB_MODES, encodeOccurrence, ValidationError } from '@sulai/core';
import type {
  ArtifactId,
  GitBlobMode,
  OccurrenceEntry,
  OccurrenceExclusion,
  OccurrenceSkip,
  SkipReason,
  WorktreeState,
} from '@sulai/core';
import {
  listTree,
  listWorktree,
  openCommit,
  openWorktree,
  readBlobs,
  worktreeChanges,
} from './git.js';
import type { GitCommit, GitWorktree } from './git.js';
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
  stageChunks,
  stageFromHandle,
  writeImmutable,
} from './store.js';
import type { Staged, StagedArtifact } from './store.js';

/**
 * A root to acquire: the path of a file or a folder, a Git repository whose
 * HEAD commit is read, or a Git repository whose working tree is observed.
 */
export type AcquisitionRoot =
  string | { readonly git: string } | { readonly worktree: string };

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

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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

const isBlobMode = (mode: string): mode is GitBlobMode =>
  (GIT_BLOB_MODES as readonly string[]).includes(mode);

interface FolderRoot {
  readonly source: 'filesystem';
  readonly id: string;
  readonly kind: 'file' | 'directory';
  readonly locator: string;
  readonly real: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface CommitRoot {
  readonly source: 'git';
  readonly id: string;
  readonly locator: string;
  readonly commit: GitCommit;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface WorktreeRoot {
  readonly source: 'git-worktree';
  readonly id: string;
  readonly locator: string;
  readonly worktree: GitWorktree;
  readonly dev: bigint;
  readonly ino: bigint;
}

type CheckedRoot = FolderRoot | CommitRoot | WorktreeRoot;

/** The folder a Git root's repository occupies on disk. */
const gitFolder = (root: CommitRoot | WorktreeRoot) =>
  root.source === 'git' ? root.commit.folder : root.worktree.folder;

const sameDirectory = (
  a: { dev: bigint; ino: bigint },
  b: { dev: bigint; ino: bigint },
) => a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;

/** Why two roots cannot be acquired together, or null when they can. */
function conflict(a: CheckedRoot, b: CheckedRoot): string | null {
  if (a.source === 'git' && b.source === 'git') {
    // One repository at two commits, as through two worktrees, is two pieces
    // of evidence. The same commit twice is an accident.
    return a.commit.repository === b.commit.repository &&
      a.commit.commit === b.commit.commit
      ? 'are the same commit of the same repository'
      : null;
  }
  if (a.source === 'git-worktree' && b.source === 'git-worktree') {
    return a.worktree.folder === b.worktree.folder
      ? 'are the same working tree'
      : null;
  }
  if (a.source !== 'filesystem' && b.source !== 'filesystem') {
    // A commit and a working tree answer different questions, even about one
    // repository, so both can be evidence together.
    return null;
  }
  if (a.source !== 'filesystem' || b.source !== 'filesystem') {
    const [repository, folder] = (
      a.source === 'filesystem' ? [b, a] : [a, b]
    ) as [CommitRoot | WorktreeRoot, FolderRoot];
    const top = gitFolder(repository);
    const meets =
      isWithin(top, folder.real) ||
      (folder.kind === 'directory' && isWithin(folder.real, top));
    return meets
      ? "overlap; a folder root cannot lie inside or contain a Git root's repository"
      : null;
  }
  const overlaps =
    (a.kind === 'directory' && isWithin(a.real, b.real)) ||
    (b.kind === 'directory' && isWithin(b.real, a.real)) ||
    (a.kind === 'directory' && b.kind === 'directory' && sameDirectory(a, b)) ||
    (a.kind === 'file' && b.kind === 'file' && a.real === b.real);
  return overlaps
    ? 'overlap; every input must belong to exactly one root'
    : null;
}

/**
 * Checks every root before anything is captured, so a root that is missing, a
 * link, not a file or directory, inside the project store, overlapping another
 * root, or not a repository with a commit refuses the whole acquisition and
 * nothing is recorded. The record has no way to state that a named root was
 * absent, and an acquisition that silently dropped one would misstate what was
 * chosen.
 */
async function checkRoots(
  inputs: readonly AcquisitionRoot[],
  storePath: string,
): Promise<CheckedRoot[]> {
  if (inputs.length === 0) {
    throw new ValidationError('Name at least one path to import');
  }
  const roots: CheckedRoot[] = [];
  for (const [index, input] of inputs.entries()) {
    const id = `r${index + 1}`;
    const named =
      typeof input === 'string'
        ? input
        : typeof input === 'object' && input !== null
          ? 'git' in input && typeof input.git === 'string'
            ? input.git
            : 'worktree' in input && typeof input.worktree === 'string'
              ? input.worktree
              : null
          : null;
    if (named === null) {
      throw new ValidationError(
        'Each root is a path, { git: path } or { worktree: path }',
      );
    }
    const locator = resolve(named);
    if (isWithin(storePath, locator)) {
      throw new ValidationError('Cannot acquire from inside the project store');
    }
    if (typeof input !== 'string' && 'worktree' in input) {
      const worktree = await openWorktree(locator);
      const stat = await lstat(worktree.folder, { bigint: true });
      roots.push({
        source: 'git-worktree',
        id,
        locator,
        worktree,
        dev: stat.dev,
        ino: stat.ino,
      });
      continue;
    }
    if (typeof input !== 'string') {
      const commit = await openCommit(locator);
      const stat = await lstat(commit.folder, { bigint: true });
      roots.push({
        source: 'git',
        id,
        locator,
        commit,
        dev: stat.dev,
        ino: stat.ino,
      });
      continue;
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
      source: 'filesystem',
      id,
      kind: stat.isFile() ? 'file' : 'directory',
      locator,
      // Compared by real path, so a root reached through a linked ancestor
      // is still recognized as the same place.
      real: await realpath(locator),
      dev: stat.dev,
      ino: stat.ino,
    });
  }
  for (const [index, a] of roots.entries()) {
    for (const b of roots.slice(index + 1)) {
      const reason = conflict(a, b);
      if (reason !== null) {
        throw new ValidationError(`Roots ${a.id} and ${b.id} ${reason}`);
      }
    }
  }
  return roots;
}

/**
 * Asks Git, for every repository with a working tree, whether it differs from
 * the commit about to be read. This runs before anything is captured, so a
 * refusal leaves the store as it was. Refusing is this command's policy, a
 * fail-safe for a caller that could mistake the commit for its current work;
 * the record states what was found either way.
 */
async function checkWorktrees(
  roots: readonly CheckedRoot[],
  storePath: string,
  allowUncommitted: boolean,
): Promise<Map<string, { state: WorktreeState; changes: string[] }>> {
  const states = new Map<string, { state: WorktreeState; changes: string[] }>();
  const store = await realpath(storePath);
  for (const root of roots) {
    if (root.source !== 'git') continue;
    const { commit } = root;
    if (commit.bare) {
      states.set(root.id, { state: 'absent', changes: [] });
      continue;
    }
    // The project's own store is not the user's work, even when untracked.
    const inside = isWithin(commit.folder, store)
      ? relative(commit.folder, store).split(sep).join('/')
      : null;
    const changes = await worktreeChanges(commit, inside);
    if (changes.length > 0 && !allowUncommitted) {
      const shown = changes.slice(0, 5).join(', ');
      const more = changes.length > 5 ? `, and ${changes.length - 5} more` : '';
      throw new ValidationError(
        `${root.id} (${root.locator}): the working tree differs from commit ${commit.commit.slice(0, 12)} in ${changes.length} path(s): ${shown}${more}. Commit first, or capture the commit anyway with --allow-uncommitted.`,
      );
    }
    states.set(root.id, {
      state: changes.length > 0 ? 'differs' : 'clean',
      changes,
    });
  }
  return states;
}

/**
 * Preserves files, every file under directories, and the contents of commits,
 * from one or more roots, and records the attempt as one import occurrence.
 * Roots are numbered `r1`, `r2` and so on in the order given.
 *
 * A folder root is walked. Only the named roots are read. Symbolic links and
 * junctions are never followed, and no content is read for references to
 * anything else, so an acquisition never reaches outside what the caller
 * chose. The project's own store is excluded in whichever root contains it. An
 * input that cannot be captured is recorded as skipped with a reason and the
 * rest continues; a failure of the store, or a root that cannot be listed at
 * all, stops the acquisition.
 *
 * A Git root is read from the repository's objects (ADR 0009): the commit HEAD
 * names, resolved once, with every tracked path as committed and nothing
 * untracked or ignored. Each blob is checked against its ID as it is read. If
 * the working tree differs from that commit, the acquisition is refused unless
 * `allowUncommitted` is set, and the record says which it was.
 *
 * A working-tree root (ADR 0012) holds every tracked file present and every
 * untracked file Git does not ignore, read from the working tree as a folder
 * walk reads files. Ignored files are never listed; submodules and repositories
 * nested in untracked files are excluded and not entered; links are skipped,
 * never followed; the project's store is excluded even if tracked.
 *
 * Every artifact is published before the occurrence, so an occurrence never
 * names bytes the store does not hold. The walk of a folder is not atomic.
 * Inputs that appear during it may be missed, and a complete occurrence means
 * that everything the walk found was captured, not that the result is a
 * snapshot of one instant. A commit does not change, so it is exact.
 */
export async function importPaths(
  directory: string,
  inputs: readonly AcquisitionRoot[],
  options: { readonly allowUncommitted?: boolean } = {},
) {
  const project = await loadProject(directory);
  const roots = await checkRoots(inputs, project.store);
  const worktrees = await checkWorktrees(
    roots,
    project.store,
    options.allowUncommitted === true,
  );
  const store = await lstat(project.store, { bigint: true });
  const isStore = (stat: { dev: bigint; ino: bigint }, path: string) =>
    sameDirectory(stat, store) || relative(project.store, path) === '';
  const otherRoot = (stat: { dev: bigint; ino: bigint }, root: string) =>
    roots.find(
      (other) =>
        other.id !== root &&
        (other.source !== 'filesystem' || other.kind === 'directory') &&
        sameDirectory(stat, other),
    );

  const startedAt = new Date().toISOString();
  const nonce = randomBytes(16).toString('hex');
  const entries: OccurrenceEntry[] = [];
  const skipped: OccurrenceSkip[] = [];
  const excluded: OccurrenceExclusion[] = [];
  const isNew = new Map<ArtifactId, boolean>();

  async function publish(staged: Staged): Promise<void> {
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
    isNew.set(staged.id, isNew.get(staged.id) ?? created);
  }

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
    await publish(staged);
    entries.push({
      root,
      path,
      artifact: staged.id,
      byteLength: staged.byteLength,
      modifiedAt: staged.modifiedAt,
      new: isNew.get(staged.id) as boolean,
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

  /**
   * Reads every path in the commit's tree. A submodule names another
   * repository's commit and is excluded; every blob, a symbolic link's target
   * included, is preserved as its bytes. Each distinct blob is read once.
   */
  async function read(root: CommitRoot): Promise<void> {
    const blobs: { path: string; mode: GitBlobMode; blob: string }[] = [];
    for (const item of await listTree(root.commit)) {
      let path: string;
      try {
        path = utf8.decode(item.path);
      } catch {
        const lossy = item.path.toString('utf8');
        skipped.push({ root: root.id, path: lossy, reason: 'non-utf8-name' });
        continue;
      }
      if (
        path
          .split('/')
          .some((part) => part === '' || part === '.' || part === '..')
      ) {
        throw new ValidationError(
          `${root.id}: the commit holds a path that cannot be recorded: ${path}`,
        );
      }
      if (item.mode === '160000' && item.type === 'commit') {
        excluded.push({
          root: root.id,
          path,
          reason: 'submodule',
          commit: item.id,
        });
      } else if (item.type === 'blob' && isBlobMode(item.mode)) {
        blobs.push({ path, mode: item.mode, blob: item.id });
      } else {
        throw new ValidationError(
          `${root.id}: the commit holds a ${item.type} with mode ${item.mode} at ${path}, which cannot be read`,
        );
      }
    }
    const captured = new Map<string, Staged>();
    const distinct = [...new Set(blobs.map((item) => item.blob))];
    for await (const blob of readBlobs(root.commit, distinct)) {
      const staged = await stageChunks(project.temporary, blob.chunks);
      await publish(staged);
      captured.set(blob.id, staged);
    }
    for (const item of blobs) {
      const staged = captured.get(item.blob) as Staged;
      entries.push({
        root: root.id,
        path: item.path,
        artifact: staged.id,
        byteLength: staged.byteLength,
        mode: item.mode,
        blob: item.blob,
        new: isNew.get(staged.id) as boolean,
      });
    }
  }

  /**
   * Captures what Git selects in a working tree: every index entry still
   * present, and every untracked path it does not ignore. A tracked file
   * missing from the working tree is not selected; its absence is the tree's
   * state. An untracked path gone by the time it is read vanished during the
   * acquisition, and is skipped. A submodule, or a repository nested in
   * untracked files, is excluded and not entered. A link is skipped, never
   * followed.
   */
  async function observe(root: WorktreeRoot): Promise<void> {
    const { folder } = root.worktree;
    // The store is never read as evidence, even when Git would select it.
    // Git names the working tree by its real path, so the store's is used too.
    const real = await realpath(project.store);
    const store = isWithin(folder, real)
      ? relative(folder, real).split(sep).join('/')
      : null;
    let storeSelected = false;
    const listing = await listWorktree(root.worktree);
    const selected: {
      raw: Buffer;
      tracked: boolean;
      submodule?: string;
      nested?: boolean;
    }[] = [
      ...listing.tracked.map((item) =>
        item.mode === '160000'
          ? { raw: item.path, tracked: true, submodule: item.id }
          : { raw: item.path, tracked: true },
      ),
      ...listing.untracked.map((raw) =>
        raw.at(-1) === 0x2f
          ? { raw: raw.subarray(0, -1), tracked: false, nested: true }
          : { raw, tracked: false },
      ),
    ];
    for (const item of selected) {
      let path: string;
      try {
        path = utf8.decode(item.raw);
      } catch {
        skipped.push({
          root: root.id,
          path: item.raw.toString('utf8'),
          reason: 'non-utf8-name',
        });
        continue;
      }
      if (store !== null && (path === store || path.startsWith(`${store}/`))) {
        storeSelected = true;
        continue;
      }
      if (item.submodule !== undefined) {
        excluded.push({
          root: root.id,
          path,
          reason: 'submodule',
          commit: item.submodule,
        });
        continue;
      }
      if (item.nested === true) {
        excluded.push({ root: root.id, path, reason: 'nested-repository' });
        continue;
      }
      const absolute = join(folder, ...path.split('/'));
      let stat;
      try {
        stat = await lstat(absolute, { bigint: true });
      } catch (error) {
        // The index lists a tracked path whether or not it exists, so a
        // missing one is the working tree's state. An untracked path was
        // listed from the working tree, so a missing one vanished during the
        // acquisition, and must not be left out of a complete occurrence.
        if (item.tracked && hasCode(error, 'ENOENT', 'ENOTDIR')) continue;
        const reason = listFailure(error);
        if (reason === null) throw error;
        skipped.push({ root: root.id, path, reason });
        continue;
      }
      if (stat.isSymbolicLink()) {
        skipped.push({ root: root.id, path, reason: 'symbolic-link' });
      } else if (stat.isFile()) {
        await capture(root.id, absolute, path);
      } else {
        skipped.push({ root: root.id, path, reason: 'not-regular-file' });
      }
    }
    if (storeSelected) {
      excluded.push({
        root: root.id,
        path: store as string,
        reason: 'project-store',
      });
    }
  }

  for (const root of roots) {
    if (root.source === 'git') await read(root);
    else if (root.source === 'git-worktree') await observe(root);
    else if (root.kind === 'file') await capture(root.id, root.locator, '');
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
    version: 3,
    nonce,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: skipped.length === 0 ? 'complete' : 'partial',
    roots: roots.map((root) =>
      root.source === 'git-worktree'
        ? {
            id: root.id,
            source: 'git-worktree',
            objectFormat: root.worktree.objectFormat,
            head: root.worktree.head,
            tree: root.worktree.tree,
            selection: 'tracked-and-unignored',
            platform: process.platform,
            locator: root.locator,
          }
        : root.source === 'git'
          ? {
              id: root.id,
              source: 'git',
              objectFormat: root.commit.objectFormat,
              commit: root.commit.commit,
              tree: root.commit.tree,
              worktree: worktrees.get(root.id)?.state,
              platform: process.platform,
              locator: root.locator,
            }
          : {
              id: root.id,
              source: 'filesystem',
              kind: root.kind,
              platform: process.platform,
              locator: root.locator,
            },
    ),
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
    roots: occurrence.roots.map((root) =>
      root.source === 'git-worktree'
        ? {
            id: root.id,
            source: 'git-worktree' as const,
            locator: root.locator,
            head: root.head,
          }
        : root.source === 'git'
          ? {
              id: root.id,
              source: 'git' as const,
              locator: root.locator,
              commit: root.commit,
              worktree: root.worktree,
              // What differs is reported, not recorded: the record keeps only
              // whether the working tree matched.
              ...(root.worktree === 'differs'
                ? { uncommitted: worktrees.get(root.id)?.changes ?? [] }
                : {}),
            }
          : {
              id: root.id,
              source: 'filesystem' as const,
              kind: root.kind,
              locator: root.locator,
            },
    ),
    entryCount: occurrence.entries.length,
    newArtifacts: distinct.filter(Boolean).length,
    existingArtifacts: distinct.filter((added) => !added).length,
    skipped: occurrence.skipped.map((item) => ({ ...item })),
    excluded: occurrence.excluded.map((item) => ({ ...item })),
  };
}

/** One root; see `importPaths`. */
export function importPath(
  directory: string,
  input: AcquisitionRoot,
  options: { readonly allowUncommitted?: boolean } = {},
) {
  return importPaths(directory, [input], options);
}
