/**
 * Integrity checks. Every stored artifact, occurrence and state revision is
 * verified against its identity, and revisions are proved down to their bytes.
 */
import { readdir } from 'node:fs/promises';
import { parseOccurrenceId, parseStateId, ValidationError } from '@sulai/core';
import type { ArtifactId } from '@sulai/core';
import {
  assertStoredArtifacts,
  readStoredOccurrence,
  storedOccurrenceId,
  summarizeOccurrence,
} from './occurrences.js';
import { PROJECT_FORMAT, PROJECT_VERSION, loadProject } from './project.js';
import { readAllStates, summarizeState, verifyState } from './state.js';
import { hasCode, storedArtifactId, verifyStoredArtifact } from './store.js';

/**
 * Generic integrity check. Verifies every stored artifact against its own
 * identity without interpreting any of them, and without loading any of them
 * into memory. Then verifies every occurrence record the same way, parses it
 * strictly, and checks that every artifact it names is stored at the size it
 * records. Last, it proves every state revision down to the bytes it cites.
 */
export async function inspectProject(directory: string) {
  const project = await loadProject(directory);
  const filenames = (await readdir(project.artifacts)).sort();
  const artifacts = [];
  for (const filename of filenames) {
    artifacts.push(
      await verifyStoredArtifact(project.artifacts, storedArtifactId(filename)),
    );
  }
  const stored = new Map(
    artifacts.map((artifact) => [artifact.id, artifact.byteLength]),
  );
  const occurrences = [];
  for (const filename of (await readdir(project.occurrences)).sort()) {
    const id = storedOccurrenceId(filename);
    const occurrence = await readStoredOccurrence(project.occurrences, id);
    assertStoredArtifacts(occurrence, stored);
    occurrences.push(summarizeOccurrence(id, occurrence));
  }
  occurrences.sort((a, b) =>
    a.startedAt === b.startedAt
      ? a.id.localeCompare(b.id)
      : a.startedAt.localeCompare(b.startedAt),
  );
  const states = [];
  const revisions = await readAllStates(project);
  for (const [id, revision] of revisions) {
    await verifyState(project, id, revision, revisions);
    states.push(summarizeState(id, revision));
  }
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    artifacts,
    occurrences,
    states,
  };
}

export async function inspectArtifact(directory: string, value: unknown) {
  const project = await loadProject(directory);
  return verifyStoredArtifact(project.artifacts, value);
}

/**
 * One occurrence in full, after verifying the record and, by streaming hash,
 * every artifact it names.
 */
export async function inspectOccurrence(directory: string, value: unknown) {
  const project = await loadProject(directory);
  const id = parseOccurrenceId(value);
  const occurrence = await readStoredOccurrence(project.occurrences, id);
  const stored = new Map<ArtifactId, number>();
  for (const entry of occurrence.entries) {
    if (!stored.has(entry.artifact)) {
      try {
        const verified = await verifyStoredArtifact(
          project.artifacts,
          entry.artifact,
        );
        stored.set(verified.id, verified.byteLength);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    }
  }
  assertStoredArtifacts(occurrence, stored);
  return { id, ...occurrence };
}

/** One revision in full, after proving it end to end. */
export async function inspectState(directory: string, value: unknown) {
  const project = await loadProject(directory);
  const id = parseStateId(value);
  const revisions = await readAllStates(project);
  const revision = revisions.get(id);
  if (revision === undefined) {
    throw new ValidationError('No such state revision is stored');
  }
  await verifyState(project, id, revision, revisions);
  return { id, ...revision };
}
