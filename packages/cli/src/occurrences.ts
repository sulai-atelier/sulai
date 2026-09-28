/**
 * Stored occurrence records: where they live, how they are read back and
 * verified, and how they are checked against the artifacts they name.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  MAX_OCCURRENCE_BYTES,
  occurrenceIdOf,
  parseOccurrence,
  ValidationError,
} from '@sulai/core';
import type { ArtifactId, Occurrence, OccurrenceId } from '@sulai/core';
import { readBounded } from './store.js';

/**
 * A record is stored as `<sha256>.json` whatever its version, because the hash
 * alone is unique. The version the bytes declare completes the identity.
 */
export function occurrencePath(occurrencesDirectory: string, id: OccurrenceId) {
  return join(
    occurrencesDirectory,
    `${id.slice(id.lastIndexOf(':') + 1)}.json`,
  );
}

/**
 * Reads the record stored under one hash, checks the bytes still have that
 * hash, and parses them strictly. Nothing about the inputs it names is trusted
 * until the artifacts are checked separately.
 */
async function readRecord(
  occurrencesDirectory: string,
  hash: string,
): Promise<{ id: OccurrenceId; occurrence: Occurrence }> {
  const bytes = await readBounded(
    join(occurrencesDirectory, `${hash}.json`),
    MAX_OCCURRENCE_BYTES,
  );
  if (createHash('sha256').update(bytes).digest('hex') !== hash) {
    throw new ValidationError(
      'Stored occurrence hash does not match its identity',
    );
  }
  const occurrence = parseOccurrence(bytes);
  return { id: occurrenceIdOf(bytes, occurrence.version), occurrence };
}

/** One entry of the occurrence directory, with the identity its bytes give it. */
export function readOccurrenceFile(
  occurrencesDirectory: string,
  filename: string,
) {
  if (!/^[a-f0-9]{64}\.json$/.test(filename)) {
    throw new ValidationError('Unexpected entry in the occurrence store');
  }
  return readRecord(occurrencesDirectory, filename.slice(0, -5));
}

export async function readStoredOccurrence(
  occurrencesDirectory: string,
  id: OccurrenceId,
): Promise<Occurrence> {
  const stored = await readRecord(
    occurrencesDirectory,
    id.slice(id.lastIndexOf(':') + 1),
  );
  if (stored.id !== id) {
    throw new ValidationError(
      `${id} is not stored; the record under its hash is ${stored.id}`,
    );
  }
  return stored.occurrence;
}

export function assertStoredArtifacts(
  occurrence: Occurrence,
  stored: ReadonlyMap<ArtifactId, number>,
): void {
  for (const entry of occurrence.entries) {
    const byteLength = stored.get(entry.artifact);
    if (byteLength === undefined) {
      throw new ValidationError(
        'Occurrence names an artifact that is not stored',
      );
    }
    if (byteLength !== entry.byteLength) {
      throw new ValidationError(
        'Occurrence disagrees with the stored artifact size',
      );
    }
  }
}

export function summarizeOccurrence(id: OccurrenceId, occurrence: Occurrence) {
  return {
    id,
    status: occurrence.status,
    startedAt: occurrence.startedAt,
    entries: occurrence.entries.length,
    skipped: occurrence.skipped.length,
    excluded: occurrence.excluded.length,
  };
}
