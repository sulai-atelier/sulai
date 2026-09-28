import { createHash } from 'node:crypto';
import { parseArtifactId } from './artifact.js';
import type { ArtifactId } from './artifact.js';
import {
  array,
  oneOf,
  record,
  text,
  timestamp,
  ValidationError,
} from './validation.js';

/**
 * An import occurrence is an immutable record of one acquisition event: which
 * inputs under which roots were attempted, which exact bytes each became, and
 * which could not be captured and why. It is separate from artifact identity,
 * because the same bytes can arrive in many events and an event is not bytes.
 * It knows nothing about any provider.
 *
 * Version 2 adds Git roots (ADR 0009): one commit read from a repository's
 * objects, not a folder walked on disk. Version 1 records stay valid, and every
 * one of their roots is a filesystem root.
 */
export const OCCURRENCE_FORMAT = 'sulai.occurrence';

/** The version new records are written in. */
export const OCCURRENCE_VERSION = 2;
export type OccurrenceVersion = 1 | 2;

/**
 * Bounds any in-memory read of one occurrence record. This limits a reader of
 * the record, not storage.
 */
export const MAX_OCCURRENCE_BYTES = 64 * 1024 * 1024;

export type OccurrenceId = `occurrence:v${OccurrenceVersion}:${string}`;

export const SKIP_REASONS = [
  'symbolic-link',
  'not-regular-file',
  'unreadable',
  'vanished',
  'changed-during-read',
  'non-utf8-name',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const EXCLUSION_REASONS = ['project-store', 'submodule'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const GIT_OBJECT_FORMATS = ['sha1', 'sha256'] as const;
export type GitObjectFormat = (typeof GIT_OBJECT_FORMATS)[number];

/** The tree modes of a captured blob: regular, executable, symbolic link. */
export const GIT_BLOB_MODES = ['100644', '100755', '120000'] as const;
export type GitBlobMode = (typeof GIT_BLOB_MODES)[number];

export const WORKTREE_STATES = ['clean', 'differs', 'absent'] as const;
export type WorktreeState = (typeof WORKTREE_STATES)[number];

/** A file or a directory walked on the acquiring machine. */
export interface FilesystemRoot {
  readonly id: string;
  /** Recorded from version 2 on; absent from version 1 records. */
  readonly source?: 'filesystem';
  readonly kind: 'file' | 'directory';
  /** The acquiring platform, which says how to read `locator`. */
  readonly platform: string;
  /**
   * Where the root was on the acquiring machine, as observed. History, not a
   * live pointer: never part of any identity and never opened by a reader.
   */
  readonly locator: string;
}

/** One commit, read from a Git repository's objects. */
export interface GitRoot {
  readonly id: string;
  readonly source: 'git';
  readonly objectFormat: GitObjectFormat;
  /** The full ID of the commit read. What named it, such as HEAD, is not kept. */
  readonly commit: string;
  readonly tree: string;
  /**
   * What Sulai's own check of the working tree found when the commit was read:
   * `clean`, `differs` when captured anyway, or `absent` for a bare repository.
   * The check runs no filter program, so it can find a difference where Git,
   * running the filter, would not. It is not Git's verdict.
   */
  readonly worktree: WorktreeState;
  readonly platform: string;
  /** Where the repository was, as observed. Not identity, as for a folder. */
  readonly locator: string;
}

export type OccurrenceRoot = FilesystemRoot | GitRoot;

export interface FileEntry {
  readonly root: string;
  /** Relative to the root, `/`-separated; empty only for a file root. */
  readonly path: string;
  readonly artifact: ArtifactId;
  readonly byteLength: number;
  /** The filesystem's modification time when the input was read, unverified. */
  readonly modifiedAt: string;
  /** Whether this acquisition added the bytes to the store. */
  readonly new: boolean;
}

export interface GitEntry {
  readonly root: string;
  readonly path: string;
  readonly artifact: ArtifactId;
  readonly byteLength: number;
  /** A symbolic link's bytes are its target; it is never followed. */
  readonly mode: GitBlobMode;
  /** The blob ID the tree names, checked against the bytes as they were read. */
  readonly blob: string;
  readonly new: boolean;
}

export type OccurrenceEntry = FileEntry | GitEntry;

export interface OccurrenceSkip {
  readonly root: string;
  readonly path: string;
  readonly reason: SkipReason;
}

/** The project's own store, excluded from a folder walk that reaches it. */
export interface StoreExclusion {
  readonly root: string;
  readonly path: string;
  readonly reason: 'project-store';
}

/** A submodule names another repository's commit, which is not entered. */
export interface SubmoduleExclusion {
  readonly root: string;
  readonly path: string;
  readonly reason: 'submodule';
  readonly commit: string;
}

export type OccurrenceExclusion = StoreExclusion | SubmoduleExclusion;

export interface Occurrence {
  readonly format: typeof OCCURRENCE_FORMAT;
  readonly version: OccurrenceVersion;
  /** Makes two otherwise identical acquisitions two distinct events. */
  readonly nonce: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** `partial` exactly when something found could not be captured. */
  readonly status: 'complete' | 'partial';
  readonly roots: readonly OccurrenceRoot[];
  readonly entries: readonly OccurrenceEntry[];
  readonly skipped: readonly OccurrenceSkip[];
  readonly excluded: readonly OccurrenceExclusion[];
}

const isFileRoot = (root: OccurrenceRoot) =>
  root.source !== 'git' && root.kind === 'file';

function isAbsoluteFor(platform: string, locator: string): boolean {
  return platform === 'win32'
    ? /^[A-Za-z]:\\/.test(locator) || locator.startsWith('\\\\')
    : locator.startsWith('/');
}

/** A full object ID in the repository's object format, in lowercase. */
function objectId(
  value: unknown,
  format: GitObjectFormat,
  label: string,
): string {
  if (typeof value !== 'string' || !/^[a-f0-9]+$/.test(value)) {
    throw new ValidationError(`${label} must be a lowercase object ID`);
  }
  if (value.length !== (format === 'sha1' ? 40 : 64)) {
    throw new ValidationError(`${label} is not a full ${format} object ID`);
  }
  return value;
}

function rootPlace(input: Record<string, unknown>, index: number) {
  if (input.id !== `r${index + 1}`) {
    throw new ValidationError(
      'Occurrence roots must be numbered r1, r2, ... in order',
    );
  }
  if (
    typeof input.platform !== 'string' ||
    !/^[a-z0-9]{1,32}$/.test(input.platform)
  ) {
    throw new ValidationError('Occurrence root platform is invalid');
  }
  const locator = text(input.locator, 'Occurrence root locator');
  if (locator.includes('\0') || !isAbsoluteFor(input.platform, locator)) {
    throw new ValidationError(
      'Occurrence root locator must be an absolute path for its platform',
    );
  }
  return { id: input.id, platform: input.platform, locator };
}

const rootKind = (value: unknown) =>
  oneOf(value, ['file', 'directory'] as const, 'Occurrence root kind');

function parseRoot(
  version: OccurrenceVersion,
): (value: unknown, index: number) => OccurrenceRoot {
  return (value, index) => {
    if (version === 1) {
      const input = record(
        value,
        ['id', 'kind', 'platform', 'locator'],
        'Occurrence root',
      );
      const { id, platform, locator } = rootPlace(input, index);
      return { id, kind: rootKind(input.kind), platform, locator };
    }
    const source = oneOf(
      (value as { source?: unknown } | null)?.source,
      ['filesystem', 'git'] as const,
      'Occurrence root source',
    );
    if (source === 'filesystem') {
      const input = record(
        value,
        ['id', 'source', 'kind', 'platform', 'locator'],
        'Occurrence root',
      );
      const { id, platform, locator } = rootPlace(input, index);
      return { id, source, kind: rootKind(input.kind), platform, locator };
    }
    const input = record(
      value,
      [
        'id',
        'source',
        'objectFormat',
        'commit',
        'tree',
        'worktree',
        'platform',
        'locator',
      ],
      'Git root',
    );
    const { id, platform, locator } = rootPlace(input, index);
    const objectFormat = oneOf(
      input.objectFormat,
      GIT_OBJECT_FORMATS,
      'Git object format',
    );
    return {
      id,
      source,
      objectFormat,
      commit: objectId(input.commit, objectFormat, 'Git root commit'),
      tree: objectId(input.tree, objectFormat, 'Git root tree'),
      worktree: oneOf(input.worktree, WORKTREE_STATES, 'Git root worktree'),
      platform,
      locator,
    };
  };
}

function relativePath(value: unknown, root: OccurrenceRoot): string {
  const path = text(value, 'Occurrence path');
  if (isFileRoot(root)) {
    if (path !== '') {
      throw new ValidationError('A file root is recorded with an empty path');
    }
    return path;
  }
  if (
    path
      .split('/')
      .some(
        (segment) =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          segment.includes('\0'),
      )
  ) {
    throw new ValidationError(
      'Occurrence paths must be relative, /-separated and normalized',
    );
  }
  return path;
}

interface Located {
  readonly root: string;
  readonly path: string;
}

/** The root an item names, found first because it decides the item's shape. */
function rootOf(
  value: unknown,
  roots: ReadonlyMap<string, OccurrenceRoot>,
): OccurrenceRoot {
  const id = (value as { root?: unknown } | null)?.root;
  const root = typeof id === 'string' ? roots.get(id) : undefined;
  if (root === undefined) {
    throw new ValidationError('Occurrence item names an unknown root');
  }
  return root;
}

function compareLocated(
  a: Located,
  b: Located,
  order: ReadonlyMap<string, number>,
): number {
  const byRoot = (order.get(a.root) ?? 0) - (order.get(b.root) ?? 0);
  if (byRoot !== 0) return byRoot;
  return Buffer.compare(
    Buffer.from(a.path, 'utf8'),
    Buffer.from(b.path, 'utf8'),
  );
}

function assertSorted(
  items: readonly Located[],
  order: ReadonlyMap<string, number>,
  strict: boolean,
  label: string,
): void {
  for (let index = 1; index < items.length; index += 1) {
    const comparison = compareLocated(
      items[index - 1] as Located,
      items[index] as Located,
      order,
    );
    if (comparison > 0 || (strict && comparison === 0)) {
      throw new ValidationError(
        `${label} must be sorted by root and UTF-8 path, without duplicates`,
      );
    }
  }
}

const key = (item: Located) => `${item.root}\0${item.path}`;

function validate(value: unknown): Occurrence {
  const input = record(
    value,
    [
      'format',
      'version',
      'nonce',
      'startedAt',
      'finishedAt',
      'status',
      'roots',
      'entries',
      'skipped',
      'excluded',
    ],
    'Occurrence',
  );
  if (
    input.format !== OCCURRENCE_FORMAT ||
    (input.version !== 1 && input.version !== 2)
  ) {
    throw new ValidationError('Unsupported occurrence format or version');
  }
  const version: OccurrenceVersion = input.version;
  if (typeof input.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(input.nonce)) {
    throw new ValidationError(
      'Occurrence nonce must be 32 lowercase hexadecimal characters',
    );
  }
  const startedAt = timestamp(input.startedAt, 'Occurrence startedAt');
  const finishedAt = timestamp(input.finishedAt, 'Occurrence finishedAt');
  if (finishedAt < startedAt) {
    throw new ValidationError('Occurrence cannot finish before it starts');
  }

  const roots = array(input.roots, 'Occurrence roots').map(parseRoot(version));
  if (roots.length === 0) {
    throw new ValidationError('An occurrence needs at least one root');
  }
  const rootById = new Map(roots.map((root) => [root.id, root]));
  const order = new Map(roots.map((root, index) => [root.id, index]));

  const artifacts = new Map<ArtifactId, { byteLength: number; new: boolean }>();
  // Within one object format, a blob ID and its bytes determine each other.
  const blobBytes = new Map<string, ArtifactId>();
  const bytesBlob = new Map<string, string>();
  const entries = array(input.entries, 'Occurrence entries').map(
    (value): OccurrenceEntry => {
      const root = rootOf(value, rootById);
      const item = record(
        value,
        root.source === 'git'
          ? ['root', 'path', 'artifact', 'byteLength', 'mode', 'blob', 'new']
          : ['root', 'path', 'artifact', 'byteLength', 'modifiedAt', 'new'],
        'Occurrence entry',
      );
      const path = relativePath(item.path, root);
      const artifact = parseArtifactId(item.artifact);
      if (
        typeof item.byteLength !== 'number' ||
        !Number.isSafeInteger(item.byteLength) ||
        item.byteLength < 0
      ) {
        throw new ValidationError(
          'Occurrence entry byteLength must be a nonnegative safe integer',
        );
      }
      if (typeof item.new !== 'boolean') {
        throw new ValidationError('Occurrence entry new must be a boolean');
      }
      const seen = artifacts.get(artifact);
      if (
        seen !== undefined &&
        (seen.byteLength !== item.byteLength || seen.new !== item.new)
      ) {
        throw new ValidationError(
          'Entries with the same artifact disagree about it',
        );
      }
      artifacts.set(artifact, { byteLength: item.byteLength, new: item.new });
      if (root.source !== 'git') {
        return {
          root: root.id,
          path,
          artifact,
          byteLength: item.byteLength,
          modifiedAt: timestamp(item.modifiedAt, 'Occurrence entry modifiedAt'),
          new: item.new,
        };
      }
      const blob = objectId(item.blob, root.objectFormat, 'Git entry blob');
      const format = root.objectFormat;
      const knownBytes = blobBytes.get(`${format} ${blob}`);
      const knownBlob = bytesBlob.get(`${format} ${artifact}`);
      if (
        (knownBytes !== undefined && knownBytes !== artifact) ||
        (knownBlob !== undefined && knownBlob !== blob)
      ) {
        throw new ValidationError(
          'Git entries disagree about which bytes a blob holds',
        );
      }
      blobBytes.set(`${format} ${blob}`, artifact);
      bytesBlob.set(`${format} ${artifact}`, blob);
      return {
        root: root.id,
        path,
        artifact,
        byteLength: item.byteLength,
        mode: oneOf(item.mode, GIT_BLOB_MODES, 'Git entry mode'),
        blob,
        new: item.new,
      };
    },
  );
  const skipped = array(input.skipped, 'Occurrence skipped').map(
    (value): OccurrenceSkip => {
      const root = rootOf(value, rootById);
      const item = record(value, ['root', 'path', 'reason'], 'Skipped item');
      const reason = oneOf(item.reason, SKIP_REASONS, 'Skip reason');
      // A commit's tree holds only blobs and submodules, so the one thing in it
      // that cannot be recorded is a name that is not UTF-8.
      if (root.source === 'git' && reason !== 'non-utf8-name') {
        throw new ValidationError(
          'A Git root skips only names that are not valid UTF-8',
        );
      }
      return { root: root.id, path: relativePath(item.path, root), reason };
    },
  );
  const excluded = array(input.excluded, 'Occurrence excluded').map(
    (value): OccurrenceExclusion => {
      const root = rootOf(value, rootById);
      if (root.source === 'git') {
        if ((value as { reason?: unknown }).reason !== 'submodule') {
          throw new ValidationError('A Git root excludes only submodules');
        }
        const item = record(
          value,
          ['root', 'path', 'reason', 'commit'],
          'Excluded item',
        );
        return {
          root: root.id,
          path: relativePath(item.path, root),
          reason: 'submodule',
          commit: objectId(item.commit, root.objectFormat, 'Submodule commit'),
        };
      }
      const item = record(value, ['root', 'path', 'reason'], 'Excluded item');
      if (root.kind !== 'directory') {
        throw new ValidationError('Only a directory root can have exclusions');
      }
      const reason = oneOf(item.reason, EXCLUSION_REASONS, 'Exclusion reason');
      if (reason !== 'project-store') {
        throw new ValidationError('Only a Git root can exclude a submodule');
      }
      return { root: root.id, path: relativePath(item.path, root), reason };
    },
  );

  assertSorted(entries, order, true, 'Occurrence entries');
  assertSorted(excluded, order, true, 'Occurrence exclusions');
  // A name that is not valid UTF-8 is recorded through a lossy decoding, so two
  // such names can coincide. Every other skipped item names one real input.
  assertSorted(skipped, order, false, 'Occurrence skipped items');
  const captured = new Set([...entries, ...excluded].map(key));
  if (captured.size !== entries.length + excluded.length) {
    throw new ValidationError('An input cannot be both captured and excluded');
  }
  const distinct = skipped.filter((item) => item.reason !== 'non-utf8-name');
  if (
    new Set(distinct.map(key)).size !== distinct.length ||
    distinct.some((item) => captured.has(key(item)))
  ) {
    throw new ValidationError('Each input is recorded at most once');
  }
  for (const exclusion of excluded) {
    const inside = (item: Located) =>
      item.root === exclusion.root &&
      item.path.startsWith(`${exclusion.path}/`);
    if ([...entries, ...skipped, ...excluded].some(inside)) {
      throw new ValidationError(
        'Nothing is recorded inside an excluded directory',
      );
    }
  }
  for (const root of roots) {
    const items = [...entries, ...skipped].filter(
      (item) => item.root === root.id,
    );
    if (isFileRoot(root) && items.length !== 1) {
      throw new ValidationError('A file root records exactly one input');
    }
  }
  const status = oneOf(
    input.status,
    ['complete', 'partial'] as const,
    'Occurrence status',
  );
  if (status !== (skipped.length === 0 ? 'complete' : 'partial')) {
    throw new ValidationError(
      'Occurrence status must be partial exactly when inputs were skipped',
    );
  }

  return {
    format: OCCURRENCE_FORMAT,
    version,
    nonce: input.nonce,
    startedAt,
    finishedAt,
    status,
    roots,
    entries,
    skipped,
    excluded,
  };
}

/**
 * The canonical encoding: compact JSON with the fields in the order written
 * here, followed by one LF. There is exactly one encoding of each record, so
 * its identity is the hash of its bytes.
 */
function serialize(occurrence: Occurrence): Uint8Array {
  const canonical = {
    format: occurrence.format,
    version: occurrence.version,
    nonce: occurrence.nonce,
    startedAt: occurrence.startedAt,
    finishedAt: occurrence.finishedAt,
    status: occurrence.status,
    roots: occurrence.roots.map((root) =>
      root.source === 'git'
        ? {
            id: root.id,
            source: root.source,
            objectFormat: root.objectFormat,
            commit: root.commit,
            tree: root.tree,
            worktree: root.worktree,
            platform: root.platform,
            locator: root.locator,
          }
        : root.source === undefined
          ? {
              id: root.id,
              kind: root.kind,
              platform: root.platform,
              locator: root.locator,
            }
          : {
              id: root.id,
              source: root.source,
              kind: root.kind,
              platform: root.platform,
              locator: root.locator,
            },
    ),
    entries: occurrence.entries.map((entry) =>
      'blob' in entry
        ? {
            root: entry.root,
            path: entry.path,
            artifact: entry.artifact,
            byteLength: entry.byteLength,
            mode: entry.mode,
            blob: entry.blob,
            new: entry.new,
          }
        : {
            root: entry.root,
            path: entry.path,
            artifact: entry.artifact,
            byteLength: entry.byteLength,
            modifiedAt: entry.modifiedAt,
            new: entry.new,
          },
    ),
    skipped: occurrence.skipped.map((item) => ({
      root: item.root,
      path: item.path,
      reason: item.reason,
    })),
    excluded: occurrence.excluded.map((item) =>
      item.reason === 'submodule'
        ? {
            root: item.root,
            path: item.path,
            reason: item.reason,
            commit: item.commit,
          }
        : { root: item.root, path: item.path, reason: item.reason },
    ),
  };
  return Buffer.from(`${JSON.stringify(canonical)}\n`, 'utf8');
}

function freeze(occurrence: Occurrence): Occurrence {
  for (const list of [
    occurrence.roots,
    occurrence.entries,
    occurrence.skipped,
    occurrence.excluded,
  ]) {
    for (const item of list) Object.freeze(item);
    Object.freeze(list);
  }
  return Object.freeze(occurrence);
}

/** The identity of a record's bytes, which declare the given version. */
export function occurrenceIdOf(
  bytes: Uint8Array,
  version: OccurrenceVersion,
): OccurrenceId {
  if (!(bytes instanceof Uint8Array)) {
    throw new ValidationError('Occurrence content must be bytes');
  }
  return `occurrence:v${version}:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function parseOccurrenceId(value: unknown): OccurrenceId {
  if (
    typeof value !== 'string' ||
    !/^occurrence:v[12]:[a-f0-9]{64}$/.test(value)
  ) {
    throw new ValidationError('Invalid occurrence ID');
  }
  return value as OccurrenceId;
}

/**
 * Validates an occurrence and returns its canonical bytes and identity. Callers
 * build the lists already sorted; nothing is reordered on their behalf.
 */
export function encodeOccurrence(value: unknown): {
  id: OccurrenceId;
  bytes: Uint8Array;
  occurrence: Occurrence;
} {
  const occurrence = freeze(validate(value));
  const bytes = serialize(occurrence);
  if (bytes.byteLength > MAX_OCCURRENCE_BYTES) {
    throw new ValidationError(
      `Occurrence record is ${bytes.byteLength} bytes; at most ${MAX_OCCURRENCE_BYTES} are supported`,
    );
  }
  return { id: occurrenceIdOf(bytes, occurrence.version), bytes, occurrence };
}

/**
 * Parses stored bytes strictly: valid UTF-8, valid JSON, every rule above, and
 * byte-for-byte the canonical encoding. Anything else is refused.
 */
export function parseOccurrence(bytes: Uint8Array): Occurrence {
  if (!(bytes instanceof Uint8Array)) {
    throw new ValidationError('Occurrence content must be bytes');
  }
  if (bytes.byteLength > MAX_OCCURRENCE_BYTES) {
    throw new ValidationError('Occurrence record is too large');
  }
  let decoded: unknown;
  try {
    const source = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    decoded = JSON.parse(source);
  } catch {
    throw new ValidationError('Occurrence is not valid UTF-8 JSON');
  }
  const occurrence = freeze(validate(decoded));
  if (Buffer.compare(serialize(occurrence), bytes) !== 0) {
    throw new ValidationError('Occurrence is not in canonical form');
  }
  return occurrence;
}
