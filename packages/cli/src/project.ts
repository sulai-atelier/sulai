/**
 * A Sulai project on disk: the storage-format marker, the layout of `.sulai`,
 * and creating and opening a project.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ValidationError } from '@sulai/core';
import {
  STORE_MODE,
  assertDirectory,
  hasCode,
  readBounded,
  writeImmutable,
} from './store.js';

export const PROJECT_FORMAT = 'sulai.project';
export const PROJECT_VERSION = 4;

/**
 * The project marker describes the Sulai storage format only. It deliberately
 * says nothing about the format of the artifacts inside, because an artifact is
 * exact bytes of any kind. Version 1 embedded `artifactFormat`; version 2 had no
 * occurrence records; version 3 had no state revisions. All are refused rather
 * than half-verified.
 */
const PROJECT_FILE = Buffer.from(
  JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION }) + '\n',
);

function paths(directory: string) {
  const root = resolve(directory);
  const store = join(root, '.sulai');
  return {
    root,
    store,
    artifacts: join(store, 'artifacts'),
    occurrences: join(store, 'occurrences'),
    states: join(store, 'states'),
    temporary: join(store, 'tmp'),
    marker: join(store, 'project.json'),
  };
}

function describeUnsupportedMarker(bytes: Buffer): string {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { format?: unknown }).format === PROJECT_FORMAT
    ) {
      const version = (parsed as { version?: unknown }).version;
      if (version !== PROJECT_VERSION) {
        return `Project uses storage format version ${String(version)}; this build requires version ${PROJECT_VERSION}. Pre-alpha does not migrate projects.`;
      }
    }
  } catch {
    // Fall through to the generic message below.
  }
  return 'Invalid or unsupported project metadata';
}

export async function loadProject(directory: string) {
  const project = paths(directory);
  await assertDirectory(project.store);
  // Check the marker before the directories, so a project in an older format
  // is refused by name rather than for a directory it never had.
  const bytes = await readBounded(project.marker, 4096);
  if (!bytes.equals(PROJECT_FILE)) {
    throw new ValidationError(describeUnsupportedMarker(bytes));
  }
  await assertDirectory(project.artifacts);
  await assertDirectory(project.occurrences);
  await assertDirectory(project.states);
  // `.sulai/tmp` is ephemeral and is recreated on demand, so its absence does
  // not make a project invalid.
  return project;
}

export async function initializeProject(directory: string) {
  const project = paths(directory);
  await mkdir(project.root, { recursive: true });
  // Validate an existing marker before creating or publishing anything, so an
  // incompatible project is refused by version and left exactly as it was.
  try {
    const existing = await readBounded(project.marker, 4096);
    if (!existing.equals(PROJECT_FILE)) {
      throw new ValidationError(describeUnsupportedMarker(existing));
    }
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  for (const path of [
    project.store,
    project.artifacts,
    project.occurrences,
    project.states,
    project.temporary,
  ]) {
    await mkdir(path, { recursive: true, mode: STORE_MODE });
    await assertDirectory(path);
  }
  const created = await writeImmutable(
    project.temporary,
    project.marker,
    PROJECT_FILE,
  );
  return { directory: project.root, created };
}

export type Project = ReturnType<typeof paths>;
