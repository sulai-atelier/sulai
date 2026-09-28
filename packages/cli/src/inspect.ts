/**
 * Integrity checks. Every stored artifact, occurrence and state revision is
 * verified against its identity, and revisions are proved down to their bytes.
 */
import { readdir } from 'node:fs/promises';
import { parseOccurrenceId, parseStateId, ValidationError } from '@sulai/core';
import type { ArtifactId, GitObjectFormat, Occurrence } from '@sulai/core';
import { blobIdOf } from './git.js';
import {
  assertStoredArtifacts,
  readOccurrenceFile,
  readStoredOccurrence,
  summarizeOccurrence,
} from './occurrences.js';
import { PROJECT_FORMAT, PROJECT_VERSION, loadProject } from './project.js';
import type { Project } from './project.js';
import { readAllStates, summarizeState, verifyState } from './state.js';
import {
  artifactPath,
  hasCode,
  storedArtifactId,
  verifyStoredArtifact,
} from './store.js';

/**
 * Recomputes the blob ID of every Git entry from its preserved bytes, which
 * needs no repository. `known` carries blob IDs already computed, so each
 * artifact is read once per object format.
 */
async function assertGitBlobs(
  project: Project,
  occurrence: Occurrence,
  known: Map<string, string>,
): Promise<void> {
  const formats = new Map<string, GitObjectFormat>();
  for (const root of occurrence.roots) {
    if (root.source === 'git') formats.set(root.id, root.objectFormat);
  }
  for (const entry of occurrence.entries) {
    if (!('blob' in entry)) continue;
    const format = formats.get(entry.root) as GitObjectFormat;
    const key = `${format} ${entry.artifact}`;
    let blob = known.get(key);
    if (blob === undefined) {
      blob = await blobIdOf(
        artifactPath(project.artifacts, entry.artifact),
        format,
      );
      known.set(key, blob);
    }
    if (blob !== entry.blob) {
      throw new ValidationError(
        `Occurrence records blob ${entry.blob} at ${entry.root}/${entry.path}, but its bytes are blob ${blob}`,
      );
    }
  }
}

/**
 * Generic integrity check of an opened store. Verifies every stored artifact
 * against its own identity without interpreting any of them, and without
 * loading any of them into memory. Then verifies every occurrence record the
 * same way, parses it strictly, checks that every artifact it names is stored
 * at the size it records, and recomputes every Git blob ID. Last, it proves
 * every state revision down to the bytes it cites.
 */
export async function verifyProject(project: Project) {
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
  const blobs = new Map<string, string>();
  const occurrences = [];
  for (const filename of (await readdir(project.occurrences)).sort()) {
    const { id, occurrence } = await readOccurrenceFile(
      project.occurrences,
      filename,
    );
    assertStoredArtifacts(occurrence, stored);
    await assertGitBlobs(project, occurrence, blobs);
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
  return { artifacts, occurrences, states };
}

/** Verifies the whole project; see `verifyProject`. */
export async function inspectProject(directory: string) {
  const project = await loadProject(directory);
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    ...(await verifyProject(project)),
  };
}

export async function inspectArtifact(directory: string, value: unknown) {
  const project = await loadProject(directory);
  return verifyStoredArtifact(project.artifacts, value);
}

/**
 * One occurrence in full, after verifying the record and, by streaming hash,
 * every artifact it names, and recomputing every Git blob ID.
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
  await assertGitBlobs(project, occurrence, new Map());
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
