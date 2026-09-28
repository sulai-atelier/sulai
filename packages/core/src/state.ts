import { createHash } from 'node:crypto';
import { parseArtifactId } from './artifact.js';
import type { ArtifactId } from './artifact.js';
import { parseOccurrenceId } from './occurrence.js';
import type { OccurrenceId } from './occurrence.js';
import {
  array,
  oneOf,
  record,
  text,
  timestamp,
  ValidationError,
} from './validation.js';

/**
 * A state revision immutably records a view of where a project stands, plus
 * exactly what evidence that view cited. It certifies none of the view's
 * claims: every citation is either resolved to exact preserved bytes or
 * explicitly unresolved, and nothing else is asserted.
 *
 * Version 2 is version 1 except that its occurrence and its parent may be of
 * either version (ADR 0009). Version 1 records stay valid.
 */
export const STATE_FORMAT = 'sulai.state';

/** The version new revisions are written in. */
export const STATE_VERSION = 2;
export type StateVersion = 1 | 2;

/** Bounds a state page, which is read whole to find its references. */
export const MAX_STATE_PAGE_BYTES = 1024 * 1024;

export type StateId = `state:v${StateVersion}:${string}`;

export const UNRESOLVED_REASONS = [
  'unknown-root',
  'path-not-in-occurrence',
  'not-captured',
  'invalid-lines',
  'line-out-of-range',
  'not-utf8-text',
] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

export type StateReference =
  | {
      readonly locator: string;
      readonly status: 'resolved';
      readonly artifact: ArtifactId;
      readonly startByte: number;
      readonly endByte: number;
    }
  | {
      readonly locator: string;
      readonly status: 'unresolved';
      readonly reason: UnresolvedReason;
    };

export interface StateRevision {
  readonly format: typeof STATE_FORMAT;
  readonly version: StateVersion;
  readonly parent: StateId | null;
  readonly createdAt: string;
  readonly page: ArtifactId;
  readonly occurrence: OccurrenceId;
  readonly references: readonly StateReference[];
}

export interface Locator {
  readonly root: string;
  /** Relative path within the root; empty for a file root. */
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

const LOCATOR = /^(r[1-9][0-9]*)(?:\/([^#`\n]+))?#L([0-9]+)(?:-L([0-9]+))?$/;

/**
 * Reads a reference such as `r1/docs/README.md#L14-L20`, or `r3#L2` for a file
 * root. Returns null for text that is not a reference at all. Line numbers are
 * returned as written; whether they are usable is a separate question.
 */
export function parseLocator(value: string): Locator | null {
  const match = LOCATOR.exec(value);
  if (match === null) return null;
  const startLine = Number(match[3]);
  const endLine = match[4] === undefined ? startLine : Number(match[4]);
  return { root: match[1] as string, path: match[2] ?? '', startLine, endLine };
}

/** Whether a locator's lines are 1-based and in order. */
export function hasValidLines(locator: Locator): boolean {
  return (
    Number.isSafeInteger(locator.startLine) &&
    Number.isSafeInteger(locator.endLine) &&
    locator.startLine >= 1 &&
    locator.endLine >= locator.startLine
  );
}

/**
 * Every reference in a page, in order of first appearance, without repeats. A
 * reference is a single-backtick code span whose whole content is a locator;
 * any other code span is ordinary code.
 */
export function extractLocators(page: string): string[] {
  const found = new Set<string>();
  for (const match of page.matchAll(/`([^`\n]+)`/g)) {
    const content = match[1] as string;
    if (parseLocator(content) !== null) found.add(content);
  }
  return [...found];
}

function parseReference(value: unknown): StateReference {
  const status = (value as { status?: unknown } | null)?.status;
  if (status === 'resolved') {
    const input = record(
      value,
      ['locator', 'status', 'artifact', 'startByte', 'endByte'],
      'Resolved reference',
    );
    const locator = text(input.locator, 'Reference locator');
    if (parseLocator(locator) === null) {
      throw new ValidationError('Reference locator is not a locator');
    }
    const { startByte, endByte } = input;
    if (
      typeof startByte !== 'number' ||
      typeof endByte !== 'number' ||
      !Number.isSafeInteger(startByte) ||
      !Number.isSafeInteger(endByte) ||
      startByte < 0 ||
      endByte < startByte
    ) {
      throw new ValidationError(
        'A resolved reference needs an in-order byte range',
      );
    }
    return {
      locator,
      status,
      artifact: parseArtifactId(input.artifact),
      startByte,
      endByte,
    };
  }
  const input = record(
    value,
    ['locator', 'status', 'reason'],
    'Unresolved reference',
  );
  if (input.status !== 'unresolved') {
    throw new ValidationError('Reference status is not a recognized value');
  }
  const locator = text(input.locator, 'Reference locator');
  if (parseLocator(locator) === null) {
    throw new ValidationError('Reference locator is not a locator');
  }
  return {
    locator,
    status: 'unresolved',
    reason: oneOf(input.reason, UNRESOLVED_REASONS, 'Unresolved reason'),
  };
}

function validate(value: unknown): StateRevision {
  const input = record(
    value,
    [
      'format',
      'version',
      'parent',
      'createdAt',
      'page',
      'occurrence',
      'references',
    ],
    'State revision',
  );
  if (
    input.format !== STATE_FORMAT ||
    (input.version !== 1 && input.version !== 2)
  ) {
    throw new ValidationError('Unsupported state format or version');
  }
  const version: StateVersion = input.version;
  const parent = input.parent === null ? null : parseStateId(input.parent);
  const occurrence = parseOccurrenceId(input.occurrence);
  if (
    version === 1 &&
    (!occurrence.startsWith('occurrence:v1:') ||
      (parent !== null && !parent.startsWith('state:v1:')))
  ) {
    throw new ValidationError(
      'A version 1 state revision names only version 1 records',
    );
  }
  const references = array(input.references, 'State references').map(
    parseReference,
  );
  if (
    new Set(references.map((reference) => reference.locator)).size !==
    references.length
  ) {
    throw new ValidationError('Each locator is recorded once');
  }
  return {
    format: STATE_FORMAT,
    version,
    parent,
    createdAt: timestamp(input.createdAt, 'State createdAt'),
    page: parseArtifactId(input.page),
    occurrence,
    references,
  };
}

function serialize(revision: StateRevision): Uint8Array {
  const canonical = {
    format: revision.format,
    version: revision.version,
    parent: revision.parent,
    createdAt: revision.createdAt,
    page: revision.page,
    occurrence: revision.occurrence,
    references: revision.references.map((reference) =>
      reference.status === 'resolved'
        ? {
            locator: reference.locator,
            status: reference.status,
            artifact: reference.artifact,
            startByte: reference.startByte,
            endByte: reference.endByte,
          }
        : {
            locator: reference.locator,
            status: reference.status,
            reason: reference.reason,
          },
    ),
  };
  return Buffer.from(`${JSON.stringify(canonical)}\n`, 'utf8');
}

function freeze(revision: StateRevision): StateRevision {
  for (const reference of revision.references) Object.freeze(reference);
  Object.freeze(revision.references);
  return Object.freeze(revision);
}

/** The identity of a revision's bytes, which declare the given version. */
export function stateIdOf(bytes: Uint8Array, version: StateVersion): StateId {
  if (!(bytes instanceof Uint8Array)) {
    throw new ValidationError('State content must be bytes');
  }
  return `state:v${version}:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function parseStateId(value: unknown): StateId {
  if (typeof value !== 'string' || !/^state:v[12]:[a-f0-9]{64}$/.test(value)) {
    throw new ValidationError('Invalid state ID');
  }
  return value as StateId;
}

/** Validates a state revision and returns its canonical bytes and identity. */
export function encodeStateRevision(value: unknown): {
  id: StateId;
  bytes: Uint8Array;
  revision: StateRevision;
} {
  const revision = freeze(validate(value));
  const bytes = serialize(revision);
  return { id: stateIdOf(bytes, revision.version), bytes, revision };
}

/**
 * Parses stored bytes strictly: valid UTF-8, valid JSON, every rule above, and
 * byte-for-byte the canonical encoding.
 */
export function parseStateRevision(bytes: Uint8Array): StateRevision {
  if (!(bytes instanceof Uint8Array)) {
    throw new ValidationError('State content must be bytes');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    throw new ValidationError('State revision is not valid UTF-8 JSON');
  }
  const revision = freeze(validate(decoded));
  if (Buffer.compare(serialize(revision), bytes) !== 0) {
    throw new ValidationError('State revision is not in canonical form');
  }
  return revision;
}
