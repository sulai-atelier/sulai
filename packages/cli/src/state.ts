/**
 * State revisions (ADR 0007). A revision records a view of the project and
 * exactly what evidence it cited. It certifies none of the view's claims.
 */
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  MAX_OCCURRENCE_BYTES,
  MAX_STATE_PAGE_BYTES,
  encodeStateRevision,
  extractLocators,
  hashContent,
  parseLocator,
  parseOccurrenceId,
  parseStateId,
  parseStateRevision,
  stateIdOf,
  ValidationError,
} from '@sulai/core';
import type {
  ArtifactId,
  StateId,
  StateReference,
  StateRevision,
} from '@sulai/core';
import { readStoredArtifact } from './artifacts.js';
import { readStoredOccurrence } from './occurrences.js';
import { loadProject } from './project.js';
import type { Project } from './project.js';
import {
  pageLines,
  readRange,
  resolveReferences,
  sameEvidence,
} from './references.js';
import {
  artifactPath,
  readBounded,
  verifyStoredArtifact,
  writeImmutable,
} from './store.js';

/** The most evidence `why` returns for one reference. */
export const MAX_WHY_BYTES = 1024 * 1024;

function statePath(statesDirectory: string, id: StateId) {
  return join(statesDirectory, `${id.slice('state:v1:'.length)}.json`);
}

function storedStateId(filename: string): StateId {
  if (!/^[a-f0-9]{64}\.json$/.test(filename)) {
    throw new ValidationError('Unexpected entry in the state store');
  }
  return parseStateId(`state:v1:${filename.slice(0, -5)}`);
}

async function readStoredState(
  statesDirectory: string,
  id: StateId,
): Promise<StateRevision> {
  const bytes = await readBounded(
    statePath(statesDirectory, id),
    MAX_OCCURRENCE_BYTES,
  );
  if (stateIdOf(bytes) !== id) {
    throw new ValidationError('Stored state hash does not match its identity');
  }
  return parseStateRevision(bytes);
}

export async function readAllStates(project: Project) {
  const revisions = new Map<StateId, StateRevision>();
  for (const filename of (await readdir(project.states)).sort()) {
    const id = storedStateId(filename);
    revisions.set(id, await readStoredState(project.states, id));
  }
  return revisions;
}

function headsOf(revisions: ReadonlyMap<StateId, StateRevision>): StateId[] {
  const parents = new Set(
    [...revisions.values()].map((revision) => revision.parent),
  );
  return [...revisions.keys()].filter((id) => !parents.has(id)).sort();
}

function countReferences(revision: StateRevision) {
  const unresolved = revision.references.filter(
    (reference) => reference.status === 'unresolved',
  );
  return {
    total: revision.references.length,
    resolved: revision.references.length - unresolved.length,
    unresolved: unresolved.map((reference) => ({
      locator: reference.locator,
      reason: reference.status === 'unresolved' ? reference.reason : undefined,
    })),
  };
}

export function summarizeState(id: StateId, revision: StateRevision) {
  const counts = countReferences(revision);
  return {
    id,
    parent: revision.parent,
    createdAt: revision.createdAt,
    occurrence: revision.occurrence,
    references: { total: counts.total, resolved: counts.resolved },
  };
}

async function readPage(project: Project, page: ArtifactId) {
  const artifact = await readStoredArtifact(
    project.root,
    page,
    MAX_STATE_PAGE_BYTES,
  );
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    artifact.bytes(),
  );
}

/**
 * Proves a revision end to end: its page and occurrence verify, its parent is
 * stored, the page cites exactly the recorded locators in order, and resolving
 * them again against that occurrence gives exactly the recorded references,
 * artifact and byte range included.
 */
export async function verifyState(
  project: Project,
  id: StateId,
  revision: StateRevision,
  revisions: ReadonlyMap<StateId, StateRevision>,
): Promise<void> {
  if (revision.parent !== null && !revisions.has(revision.parent)) {
    throw new ValidationError(`State ${id} names a parent that is not stored`);
  }
  const page = await readPage(project, revision.page);
  const occurrence = await readStoredOccurrence(
    project.occurrences,
    revision.occurrence,
  );
  const locators = extractLocators(page);
  const recorded = revision.references.map((reference) => reference.locator);
  if (JSON.stringify(locators) !== JSON.stringify(recorded)) {
    throw new ValidationError(
      `State ${id} does not record exactly what its page cites`,
    );
  }
  const again = await resolveReferences(project, occurrence, locators);
  if (JSON.stringify(again) !== JSON.stringify(revision.references)) {
    throw new ValidationError(
      `State ${id} records references its occurrence does not support`,
    );
  }
}

/** A citation kept from the parent whose evidence is no longer the same bytes. */
interface ChangedCitation {
  readonly locator: string;
  readonly lines: readonly number[];
  readonly now: 'different-text' | 'unresolved';
}

/**
 * Compares every citation the page keeps from its parent. A locator is a path
 * and line range, so when its file changes it can still resolve while pointing
 * at other text. That is caught here, where it would otherwise pass unseen.
 */
async function changedCitations(
  project: Project,
  parent: StateRevision,
  references: readonly StateReference[],
  page: string,
): Promise<ChangedCitation[]> {
  const before = new Map(
    parent.references.map((reference) => [reference.locator, reference]),
  );
  const lines = pageLines(page);
  const changed: ChangedCitation[] = [];
  for (const reference of references) {
    const old = before.get(reference.locator);
    if (old === undefined || old.status !== 'resolved') continue;
    let now: ChangedCitation['now'] | null = null;
    if (reference.status !== 'resolved') now = 'unresolved';
    else if (!(await sameEvidence(project, old, reference))) {
      now = 'different-text';
    }
    if (now === null) continue;
    changed.push({
      locator: reference.locator,
      lines: lines.flatMap((text, index) =>
        extractLocators(text).includes(reference.locator) ? [index + 1] : [],
      ),
      now,
    });
  }
  return changed;
}

/**
 * Records a state page as a new revision. The page is published first and the
 * revision last, so a revision never names bytes the store does not hold. With
 * no parent given, the one head is the parent; with several heads it refuses
 * and names them rather than choosing.
 *
 * The page is a file path, or the page's bytes, so a project needs no state
 * file of its own. A citation kept from the parent must still point at the
 * same text; otherwise nothing is recorded, unless `allowChangedCitations`
 * says to record anyway.
 */
export async function recordState(
  directory: string,
  pageSource: string | Uint8Array,
  from: unknown,
  parent?: unknown,
  options: { readonly allowChangedCitations?: boolean } = {},
) {
  const project = await loadProject(directory);
  const occurrenceId = parseOccurrenceId(from);
  const occurrence = await readStoredOccurrence(
    project.occurrences,
    occurrenceId,
  );
  if (
    typeof pageSource !== 'string' &&
    pageSource.byteLength > MAX_STATE_PAGE_BYTES
  ) {
    throw new ValidationError(
      `A state page must contain at most ${MAX_STATE_PAGE_BYTES} bytes`,
    );
  }
  const bytes =
    typeof pageSource === 'string'
      ? await readBounded(resolve(pageSource), MAX_STATE_PAGE_BYTES)
      : Buffer.from(pageSource);
  let page: string;
  try {
    page = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ValidationError('A state page must be UTF-8 text');
  }
  const revisions = await readAllStates(project);
  let parentId: StateId | null;
  if (parent !== undefined) {
    parentId = parseStateId(parent);
    if (!revisions.has(parentId)) {
      throw new ValidationError('The named parent state is not stored');
    }
  } else {
    const heads = headsOf(revisions);
    if (heads.length > 1) {
      throw new ValidationError(
        `There are ${heads.length} heads; name the parent with --parent: ${heads.join(', ')}`,
      );
    }
    parentId = heads[0] ?? null;
  }
  const references = await resolveReferences(
    project,
    occurrence,
    extractLocators(page),
  );
  const changed =
    parentId === null
      ? []
      : await changedCitations(
          project,
          revisions.get(parentId) as StateRevision,
          references,
          page,
        );
  if (changed.length > 0 && options.allowChangedCitations !== true) {
    const list = changed
      .map(
        (item) =>
          `  ${item.locator} (page line ${item.lines.join(', ')}): ${item.now === 'unresolved' ? 'no longer resolves' : 'now points at different text'}`,
      )
      .join('\n');
    throw new ValidationError(
      `${changed.length} citation(s) kept from the parent no longer cite the same text:\n${list}\nCorrect them, or record anyway with --allow-changed-citations.`,
    );
  }
  const pageId = hashContent(bytes);
  await writeImmutable(
    project.temporary,
    artifactPath(project.artifacts, pageId),
    bytes,
  );
  const {
    id,
    bytes: record,
    revision,
  } = encodeStateRevision({
    format: 'sulai.state',
    version: 1,
    parent: parentId,
    createdAt: new Date().toISOString(),
    page: pageId,
    occurrence: occurrenceId,
    references,
  });
  await writeImmutable(
    project.temporary,
    statePath(project.states, id),
    record,
  );
  return {
    ...summarizeState(id, revision),
    references: countReferences(revision),
    changedCitations: changed,
  };
}

/**
 * Where the project currently appears to stand: every head, meaning every
 * revision with no children, with its page and the resolution recorded when it
 * was made. Several heads are all reported; none is named the winner. The
 * cited evidence is not re-read here; `inspect` does that.
 */
export async function projectStatus(directory: string) {
  const project = await loadProject(directory);
  const revisions = await readAllStates(project);
  const heads = [];
  for (const id of headsOf(revisions)) {
    const revision = revisions.get(id) as StateRevision;
    heads.push({
      ...summarizeState(id, revision),
      references: countReferences(revision),
      page: await readPage(project, revision.page),
    });
  }
  return { heads };
}

/**
 * One line of a revision's page and the exact evidence each of its references
 * points to. A line is only a line in this revision, not a semantic item. Each
 * distinct cited artifact is verified by streaming once, before any of its
 * ranges is read, and each range is read with bounded memory.
 */
export async function explainLine(
  directory: string,
  state: unknown,
  lineNumber: unknown,
) {
  const project = await loadProject(directory);
  const id = parseStateId(state);
  const revision = await readStoredState(project.states, id);
  const lines = pageLines(await readPage(project, revision.page));
  // Reading the page verified it, so a page that cites itself is not hashed again.
  const verified = new Set<ArtifactId>([revision.page]);
  const line = Number(lineNumber);
  if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) {
    throw new ValidationError(`The page has ${lines.length} lines`);
  }
  const text = lines[line - 1] as string;
  const occurrence = await readStoredOccurrence(
    project.occurrences,
    revision.occurrence,
  );
  const references = [];
  for (const locator of extractLocators(text)) {
    const reference = revision.references.find(
      (item) => item.locator === locator,
    );
    if (reference === undefined) {
      throw new ValidationError(`State ${id} did not record ${locator}`);
    }
    const parsed = parseLocator(locator);
    const root = occurrence.roots.find((item) => item.id === parsed?.root);
    const where = {
      root: parsed?.root,
      locator: root?.locator,
      path: parsed?.path,
    };
    if (reference.status === 'unresolved') {
      references.push({ ...reference, where });
      continue;
    }
    if (!verified.has(reference.artifact)) {
      await verifyStoredArtifact(project.artifacts, reference.artifact);
      verified.add(reference.artifact);
    }
    const evidence = await readRange(
      artifactPath(project.artifacts, reference.artifact),
      reference.startByte,
      reference.endByte,
      MAX_WHY_BYTES,
    );
    references.push({
      ...reference,
      where,
      evidence: evidence.text,
      truncated: evidence.truncated,
    });
  }
  return { state: id, line, text, references };
}

/**
 * The lines removed from and added to one revision's page to give another's,
 * in order. A plain line diff: no meaning is inferred from it.
 */
export async function diffStates(
  directory: string,
  from: unknown,
  to: unknown,
) {
  const project = await loadProject(directory);
  const a = parseStateId(from);
  const b = parseStateId(to);
  const before = pageLines(
    await readPage(project, (await readStoredState(project.states, a)).page),
  );
  const after = pageLines(
    await readPage(project, (await readStoredState(project.states, b)).page),
  );
  if (before.length * after.length > 25_000_000) {
    throw new ValidationError('These pages are too long to diff');
  }
  const table = Array.from(
    { length: before.length + 1 },
    () => new Uint32Array(after.length + 1),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      (table[i] as Uint32Array)[j] =
        before[i] === after[j]
          ? ((table[i + 1] as Uint32Array)[j + 1] as number) + 1
          : Math.max(
              (table[i + 1] as Uint32Array)[j] as number,
              (table[i] as Uint32Array)[j + 1] as number,
            );
    }
  }
  const changes: { op: '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      i += 1;
      j += 1;
    } else if (
      ((table[i + 1] as Uint32Array)[j] as number) >=
      ((table[i] as Uint32Array)[j + 1] as number)
    ) {
      changes.push({ op: '-', line: before[i] as string });
      i += 1;
    } else {
      changes.push({ op: '+', line: after[j] as string });
      j += 1;
    }
  }
  while (i < before.length)
    changes.push({ op: '-', line: before[i++] as string });
  while (j < after.length)
    changes.push({ op: '+', line: after[j++] as string });
  return { from: a, to: b, changes };
}
