/**
 * Stored occurrence records: where they live, how they are read back and
 * verified, and how they are checked against the artifacts they name.
 */
import { join } from 'node:path';
import {
  MAX_OCCURRENCE_BYTES,
  occurrenceIdOf,
  parseOccurrence,
  parseOccurrenceId,
  ValidationError,
} from '@sulai/core';
import type { ArtifactId, Occurrence, OccurrenceId } from '@sulai/core';
import { readBounded } from './store.js';

export function occurrencePath(occurrencesDirectory: string, id: OccurrenceId) {
  return join(
    occurrencesDirectory,
    `${id.slice('occurrence:v1:'.length)}.json`,
  );
}

export function storedOccurrenceId(filename: string): OccurrenceId {
  if (!/^[a-f0-9]{64}\.json$/.test(filename)) {
    throw new ValidationError('Unexpected entry in the occurrence store');
  }
  return parseOccurrenceId(`occurrence:v1:${filename.slice(0, -5)}`);
}

/**
 * Reads one stored occurrence, checks it still hashes to the name it is stored
 * under, and parses it strictly. Nothing about the inputs it names is trusted
 * until the artifacts are checked separately.
 */
export async function readStoredOccurrence(
  occurrencesDirectory: string,
  id: OccurrenceId,
): Promise<Occurrence> {
  const bytes = await readBounded(
    occurrencePath(occurrencesDirectory, id),
    MAX_OCCURRENCE_BYTES,
  );
  if (occurrenceIdOf(bytes) !== id) {
    throw new ValidationError(
      'Stored occurrence hash does not match its identity',
    );
  }
  return parseOccurrence(bytes);
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
