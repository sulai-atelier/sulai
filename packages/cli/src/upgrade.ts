/**
 * Upgrading a version 4 or 5 store to version 6 (ADR 0009, ADR 0012), the one
 * deliberate mutation of stored metadata. Every earlier record is a valid
 * version 6 record, so only the marker changes.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { ValidationError } from '@sulai/core';
import { verifyProject } from './inspect.js';
import {
  PROJECT_VERSION,
  UPGRADABLE_VERSIONS,
  describeUnsupportedMarker,
  paths,
  projectMarker,
} from './project.js';
import {
  STORE_MODE,
  assertDirectory,
  cleanupAfterFailure,
  readBounded,
  renameReplacing,
} from './store.js';

/**
 * Verifies the whole store first, exactly as `inspect` does; if anything fails,
 * the store is left as it was. A store holding a record its marker's version
 * could not have written is refused too, since the marker would then be wrong.
 * Then the version 6 marker is staged, synced and renamed over the old one, so
 * an interruption leaves one whole marker or the other, never a partial one.
 * No artifact, occurrence or state is touched. `project.json` is the only
 * stored file ever replaced, and only here.
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
  const from = [...UPGRADABLE_VERSIONS.keys()].find((version) =>
    marker.equals(projectMarker(version)),
  );
  if (from === undefined) {
    throw new ValidationError(describeUnsupportedMarker(marker));
  }
  await assertDirectory(project.artifacts);
  await assertDirectory(project.occurrences);
  await assertDirectory(project.states);
  const verified = await verifyProject(project);
  const allowed = UPGRADABLE_VERSIONS.get(from) as readonly number[];
  if (
    [...verified.occurrences, ...verified.states].some(
      (record) =>
        !allowed.includes(
          Number(/^(?:occurrence|state):v(\d+):/.exec(record.id)?.[1]),
        ),
    )
  ) {
    throw new ValidationError(
      `The store is marked version ${from} but holds records only a later version writes`,
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
    // A scanner can hold either file for a while on Windows; wait it out.
    await renameReplacing(staged, project.marker);
  } catch (error) {
    throw await cleanupAfterFailure(error, staged);
  }
  return {
    directory: project.root,
    from,
    to: PROJECT_VERSION,
    upgraded: true,
    verified: {
      artifacts: verified.artifacts.length,
      occurrences: verified.occurrences.length,
      states: verified.states.length,
    },
  };
}
