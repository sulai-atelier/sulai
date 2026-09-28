/**
 * Single artifacts: storing one file's exact bytes, and loading one stored
 * artifact whole for a reader that needs all of it.
 */
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Artifact, parseArtifactId, ValidationError } from '@sulai/core';
import { loadProject } from './project.js';
import type { Project } from './project.js';
import {
  artifactPath,
  cleanupAfterFailure,
  publishArtifact,
  readBounded,
  removeTemporaryFile,
  stageIntoTemporary,
} from './store.js';

/**
 * Stores exact bytes by streaming. This performs no format interpretation at
 * all: material that no current reader understands is still preserved
 * faithfully, so a later, better reader can re-derive from the untouched
 * original instead of requiring the user to import again.
 */
export async function importArtifactFile(directory: string, filename: string) {
  const project = await loadProject(directory);
  const staged = await stageIntoTemporary(project.temporary, resolve(filename));
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
  return { id: staged.id, byteLength: staged.byteLength, created };
}

/**
 * Loads one stored artifact into memory for a reader that needs all of it,
 * after refusing it from filesystem metadata alone if it exceeds that reader's
 * limit, and after verifying it still has the identity it is stored under.
 * Storage has no ceiling, so any reader that buffers must bound itself here.
 */
export async function readStoredArtifact(
  directory: string,
  value: unknown,
  limit: number,
): Promise<Artifact> {
  return readArtifact(await loadProject(directory), value, limit);
}

/** As `readStoredArtifact`, from a store already opened. */
export async function readArtifact(
  project: Project,
  value: unknown,
  limit: number,
): Promise<Artifact> {
  const id = parseArtifactId(value);
  const path = artifactPath(project.artifacts, id);
  const { size } = await lstat(path);
  if (size > limit) {
    throw new ValidationError(
      `Artifact is ${size} bytes; this format accepts at most ${limit}`,
    );
  }
  const artifact = new Artifact(await readBounded(path, limit));
  if (artifact.id !== id) {
    throw new ValidationError(
      'Stored artifact hash does not match its identity',
    );
  }
  return artifact;
}
