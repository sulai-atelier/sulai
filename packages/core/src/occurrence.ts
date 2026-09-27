import { createHash } from 'node:crypto';
import { parseArtifactId } from './artifact.js';
import type { ArtifactId } from './artifact.js';
import { record, ValidationError } from './validation.js';

/**
 * An import occurrence is an immutable record of one acquisition event: which
 * inputs under which roots were attempted, which exact bytes each became, and
 * which could not be captured and why. It is separate from artifact identity,
 * because the same bytes can arrive in many events and an event is not bytes.
 * It knows nothing about any provider.
 */
export const OCCURRENCE_FORMAT = 'sulai.occurrence';
export const OCCURRENCE_VERSION = 1;

/**
 * Bounds any in-memory read of one occurrence record. This limits a reader of
 * the record, not storage.
 */
export const MAX_OCCURRENCE_BYTES = 64 * 1024 * 1024;

export type OccurrenceId = `occurrence:v1:${string}`;

export const SKIP_REASONS = [
  'symbolic-link',
  'not-regular-file',
  'unreadable',
  'vanished',
  'changed-during-read',
  'non-utf8-name',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const EXCLUSION_REASONS = ['project-store'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface OccurrenceRoot {
  readonly id: string;
  readonly kind: 'file' | 'directory';
  /** The acquiring platform, which says how to read `locator`. */
  readonly platform: string;
  /**
   * Where the root was on the acquiring machine, as observed. History, not a
   * live pointer: never part of any identity and never opened by a reader.
   */
  readonly locator: string;
}

export interface OccurrenceEntry {
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

export interface OccurrenceSkip {
  readonly root: string;
  readonly path: string;
  readonly reason: SkipReason;
}

export interface OccurrenceExclusion {
  readonly root: string;
  readonly path: string;
  readonly reason: ExclusionReason;
}

export interface Occurrence {
  readonly format: typeof OCCURRENCE_FORMAT;
  readonly version: typeof OCCURRENCE_VERSION;
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

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must be an array`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw new ValidationError(`${label} must be a well-formed string`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const input = text(value, label);
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== input) {
    throw new ValidationError(`${label} must be an ISO 8601 UTC timestamp`);
  }
  return input;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw new ValidationError(`${label} is not a recognized value`);
  }
  return value as T;
}

function isAbsoluteFor(platform: string, locator: string): boolean {
  return platform === 'win32'
    ? /^[A-Za-z]:\\/.test(locator) || locator.startsWith('\\\\')
    : locator.startsWith('/');
}

function parseRoot(value: unknown, index: number): OccurrenceRoot {
  const input = record(
    value,
    ['id', 'kind', 'platform', 'locator'],
    'Occurrence root',
  );
  if (input.id !== `r${index + 1}`) {
    throw new ValidationError(
      'Occurrence roots must be numbered r1, r2, ... in order',
    );
  }
  const kind = oneOf(
    input.kind,
    ['file', 'directory'] as const,
    'Occurrence root kind',
  );
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
  return { id: input.id, kind, platform: input.platform, locator };
}

function relativePath(value: unknown, root: OccurrenceRoot): string {
  const path = text(value, 'Occurrence path');
  if (root.kind === 'file') {
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

function locate(
  value: Record<string, unknown>,
  roots: ReadonlyMap<string, OccurrenceRoot>,
): Located {
  const root =
    typeof value.root === 'string' ? roots.get(value.root) : undefined;
  if (root === undefined) {
    throw new ValidationError('Occurrence item names an unknown root');
  }
  return { root: root.id, path: relativePath(value.path, root) };
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
    input.version !== OCCURRENCE_VERSION
  ) {
    throw new ValidationError('Unsupported occurrence format or version');
  }
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

  const roots = array(input.roots, 'Occurrence roots').map(parseRoot);
  if (roots.length === 0) {
    throw new ValidationError('An occurrence needs at least one root');
  }
  const rootById = new Map(roots.map((root) => [root.id, root]));
  const order = new Map(roots.map((root, index) => [root.id, index]));

  const artifacts = new Map<ArtifactId, { byteLength: number; new: boolean }>();
  const entries = array(input.entries, 'Occurrence entries').map(
    (value): OccurrenceEntry => {
      const item = record(
        value,
        ['root', 'path', 'artifact', 'byteLength', 'modifiedAt', 'new'],
        'Occurrence entry',
      );
      const where = locate(item, rootById);
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
      return {
        ...where,
        artifact,
        byteLength: item.byteLength,
        modifiedAt: timestamp(item.modifiedAt, 'Occurrence entry modifiedAt'),
        new: item.new,
      };
    },
  );
  const skipped = array(input.skipped, 'Occurrence skipped').map(
    (value): OccurrenceSkip => {
      const item = record(value, ['root', 'path', 'reason'], 'Skipped item');
      return {
        ...locate(item, rootById),
        reason: oneOf(item.reason, SKIP_REASONS, 'Skip reason'),
      };
    },
  );
  const excluded = array(input.excluded, 'Occurrence excluded').map(
    (value): OccurrenceExclusion => {
      const item = record(value, ['root', 'path', 'reason'], 'Excluded item');
      const where = locate(item, rootById);
      if (rootById.get(where.root)?.kind !== 'directory') {
        throw new ValidationError('Only a directory root can have exclusions');
      }
      return {
        ...where,
        reason: oneOf(item.reason, EXCLUSION_REASONS, 'Exclusion reason'),
      };
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
    if (root.kind === 'file' && items.length !== 1) {
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
    version: OCCURRENCE_VERSION,
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
    roots: occurrence.roots.map((root) => ({
      id: root.id,
      kind: root.kind,
      platform: root.platform,
      locator: root.locator,
    })),
    entries: occurrence.entries.map((entry) => ({
      root: entry.root,
      path: entry.path,
      artifact: entry.artifact,
      byteLength: entry.byteLength,
      modifiedAt: entry.modifiedAt,
      new: entry.new,
    })),
    skipped: occurrence.skipped.map((item) => ({
      root: item.root,
      path: item.path,
      reason: item.reason,
    })),
    excluded: occurrence.excluded.map((item) => ({
      root: item.root,
      path: item.path,
      reason: item.reason,
    })),
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

export function occurrenceIdOf(bytes: Uint8Array): OccurrenceId {
  if (!(bytes instanceof Uint8Array)) {
    throw new ValidationError('Occurrence content must be bytes');
  }
  return `occurrence:v1:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function parseOccurrenceId(value: unknown): OccurrenceId {
  if (
    typeof value !== 'string' ||
    !/^occurrence:v1:[a-f0-9]{64}$/.test(value)
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
  return { id: occurrenceIdOf(bytes), bytes, occurrence };
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
