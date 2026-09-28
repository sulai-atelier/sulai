/**
 * Upgrading a version 4 store to version 5 (ADR 0009), the one deliberate
 * mutation of stored metadata. Every version 4 record is a valid version 5
 * record, so only the marker changes.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ValidationError } from '@sulai/core';
import { verifyProject } from './inspect.js';
import {
  PROJECT_VERSION,
  UPGRADABLE_VERSION,
  describeUnsupportedMarker,
  paths,
  projectMarker,
} from './project.js';
import {
  STORE_MODE,
  assertDirectory,
  cleanupAfterFailure,
  readBounded,
} from './store.js';

/**
 * Verifies the whole store first, exactly as `inspect` does; if anything fails,
 * the store is left as it was. Then the version 5 marker is staged, synced and
 * renamed over the old one, so an interruption leaves one whole marker or the
 * other, never a partial one. No artifact, occurrence or state is touched.
 * `project.json` is the only stored file ever replaced, and only here.
 */
export async function upgradeProject(directory: string) {
  const project = paths(directory);
  await assertDirectory(project.store);
  const marker = await readBounded(project.marker, 4096);
  if (marker.equals(projectMarker(PROJECT_VERSION))) {
    return {
      directory: project.root,
      from: PROJECT_VERSION,
      to: PROJECT_VERSION,
      upgraded: false,
    };
  }
  if (!marker.equals(projectMarker(UPGRADABLE_VERSION))) {
    throw new ValidationError(describeUnsupportedMarker(marker));
  }
  await assertDirectory(project.artifacts);
  await assertDirectory(project.occurrences);
  await assertDirectory(project.states);
  const verified = await verifyProject(project);
  // A version 4 build writes neither; one here means the marker is wrong.
  if (
    [...verified.occurrences, ...verified.states].some(
      (record) => !/^(occurrence|state):v1:/.test(record.id),
    )
  ) {
    throw new ValidationError(
      `The store is marked version ${UPGRADABLE_VERSION} but holds records only version ${PROJECT_VERSION} writes`,
    );
  }
  await mkdir(project.temporary, { recursive: true, mode: STORE_MODE });
  await assertDirectory(project.temporary);
  const staged = join(project.temporary, randomUUID());
  try {
    const handle = await open(staged, 'wx', 0o600);
    try {
      await handle.writeFile(projectMarker(PROJECT_VERSION));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staged, project.marker);
  } catch (error) {
    throw await cleanupAfterFailure(error, staged);
  }
  return {
    directory: project.root,
    from: UPGRADABLE_VERSION,
    to: PROJECT_VERSION,
    upgraded: true,
    verified: {
      artifacts: verified.artifacts.length,
      occurrences: verified.occurrences.length,
      states: verified.states.length,
    },
  };
}
