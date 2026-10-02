/**
 * The draft Sulai keeps for the agent (ADR 0013): `.sulai/draft.md`, the next
 * page in progress, and `.sulai/draft.json`, the state it began from and the
 * bytes Sulai last wrote into it. Neither is part of the format. The store is
 * never acquired and Git ignores it, so the draft is never evidence, and
 * nothing reads either file as a record.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_STATE_PAGE_BYTES, parseStateId } from '@sulai/core';
import type { StateId } from '@sulai/core';
import type { Project } from './project.js';
import { hasCode, readBounded } from './store.js';

export interface Draft {
  readonly bytes: Buffer;
  /** The state it began from; null before any; undefined when unknown. */
  readonly base: StateId | null | undefined;
  /** Whether it differs from what Sulai last wrote, or Sulai cannot tell. */
  readonly edited: boolean;
}

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

export function draftPath(project: Project): string {
  return join(project.store, 'draft.md');
}

function metaPath(project: Project): string {
  return join(project.store, 'draft.json');
}

/** The draft, or null when there is none. */
export async function readDraft(project: Project): Promise<Draft | null> {
  let bytes: Buffer;
  try {
    bytes = await readBounded(draftPath(project), MAX_STATE_PAGE_BYTES);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
  let meta: { base?: unknown; sha256?: unknown } | null = null;
  try {
    meta = JSON.parse(
      (await readBounded(metaPath(project), 4096)).toString('utf8'),
    ) as { base?: unknown; sha256?: unknown };
  } catch (error) {
    // Missing or unreadable: where the draft began is then unknown.
    if (!hasCode(error, 'ENOENT') && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  let base: StateId | null | undefined;
  if (meta?.base === null) base = null;
  else {
    try {
      base = parseStateId(meta?.base);
    } catch {
      base = undefined;
    }
  }
  return {
    bytes,
    base,
    edited: meta?.sha256 !== sha256(bytes),
  };
}

/**
 * Writes the draft, then what Sulai wrote and where it began. An interruption
 * between the two leaves a draft that reads as edited, so it is kept rather
 * than overwritten.
 */
export async function writeDraft(
  project: Project,
  bytes: Uint8Array,
  base: StateId | null,
): Promise<void> {
  await writeFile(draftPath(project), bytes);
  await writeFile(
    metaPath(project),
    `${JSON.stringify({ base, sha256: sha256(bytes) })}\n`,
  );
}
