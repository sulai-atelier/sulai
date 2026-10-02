/**
 * A Sulai project on disk: the storage-format marker, the layout of `.sulai`,
 * and creating and opening a project.
 */
import { lstat, mkdir } from 'node:fs/promises';
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
export const PROJECT_VERSION = 6;

/**
 * The earlier storage formats `sulai upgrade` accepts, each with the record
 * versions a store in that format can hold.
 */
export const UPGRADABLE_VERSIONS: ReadonlyMap<number, readonly number[]> =
  new Map([
    [4, [1]],
    [5, [1, 2]],
  ]);

/**
 * The project marker describes the Sulai storage format only. It deliberately
 * says nothing about the format of the artifacts inside, because an artifact is
 * exact bytes of any kind. Version 1 embedded `artifactFormat`; version 2 had no
 * occurrence records; version 3 had no state revisions; version 4 had no
 * version 2 occurrences or state revisions; version 5 had no version 3 ones.
 * All are refused rather than half-verified, and only versions 4 and 5 can be
 * upgraded.
 */
export function projectMarker(version: number): Buffer {
  return Buffer.from(
    JSON.stringify({ format: PROJECT_FORMAT, version }) + '\n',
  );
}

const PROJECT_FILE = projectMarker(PROJECT_VERSION);

/** Asks Git to ignore the whole store, this file included. */
const GIT_IGNORE = Buffer.from('*\n');

/** Tells whoever finds the store, most likely an agent, how to read it. */
const README = Buffer.from(`# Sulai

This folder is Sulai's store for the project around it. Its files are records,
not notes: read the project's state through the \`sulai\` command, which first
checks it against the project as it is now. From the project folder:

    sulai orient .            where the project stands, and what moved
    sulai record . <page|->   record the next state
    sulai --help              everything else

Nothing here is meant to be read or edited by hand.
`);

export function paths(directory: string) {
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
    ignore: join(store, '.gitignore'),
    readme: join(store, 'README.md'),
  };
}

export function describeUnsupportedMarker(bytes: Buffer): string {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { format?: unknown }).format === PROJECT_FORMAT
    ) {
      const version = (parsed as { version?: unknown }).version;
      const found = `Project uses storage format version ${String(version)}; this build requires version ${PROJECT_VERSION}.`;
      if (
        typeof version === 'number' &&
        UPGRADABLE_VERSIONS.has(version) &&
        bytes.equals(projectMarker(version))
      ) {
        return `${found} Upgrade it with \`sulai upgrade\`, which changes only the format marker.`;
      }
      if (version !== PROJECT_VERSION) {
        return `${found} Only versions ${[...UPGRADABLE_VERSIONS.keys()].join(' and ')} can be upgraded.`;
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
  // In a repository, committing everything must not commit the store, and an
  // agent that finds the store must learn to read it through Sulai. Not part
  // of the format: nothing reads these, and a file already there is kept.
  for (const [path, bytes] of [
    [project.ignore, GIT_IGNORE],
    [project.readme, README],
  ] as const) {
    try {
      await lstat(path);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      await writeImmutable(project.temporary, path, bytes);
    }
  }
  return { directory: project.root, created };
}

export type Project = ReturnType<typeof paths>;
