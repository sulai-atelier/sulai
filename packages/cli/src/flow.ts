/**
 * The front door an agent uses (ADR 0011). `orient` observes the project,
 * checks the current state against what it observed, and only then serves the
 * state. `recordNext` observes again and records the next revision against
 * that observation. Both are built only from acquisition, resolution and
 * recording; neither decides what a change means.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MAX_STATE_PAGE_BYTES,
  extractLocators,
  parseStateId,
  ValidationError,
} from '@sulai/core';
import type {
  ArtifactId,
  OccurrenceRoot,
  StateId,
  StateRevision,
} from '@sulai/core';
import { importPaths } from './acquire.js';
import type { AcquisitionRoot } from './acquire.js';
import { readStoredOccurrence } from './occurrences.js';
import { loadProject } from './project.js';
import type { Project } from './project.js';
import { readRange, resolveReferences } from './references.js';
import {
  changedCitations,
  headsOf,
  readAllStates,
  readPage,
  recordState,
} from './state.js';
import { artifactPath, readBounded } from './store.js';

/** The most of each side of a changed citation that `orient` returns. */
const MAX_SHOWN_BYTES = 4096;

/**
 * What to observe: the roots the given revision was recorded against, so its
 * citations keep their meaning, or, for a first revision, the project itself.
 * A repository is observed as its working tree (ADR 0012), whether it was
 * recorded that way or as a commit, because the question is whether the
 * evidence still holds for the project as it is now. Only a bare repository,
 * which has no working tree, is read as its commit again.
 */
async function rootsFor(
  project: Project,
  revision: StateRevision | undefined,
): Promise<AcquisitionRoot[]> {
  if (revision === undefined) {
    return existsSync(join(project.root, '.git'))
      ? [{ worktree: project.root }]
      : [project.root];
  }
  const occurrence = await readStoredOccurrence(
    project.occurrences,
    revision.occurrence,
  );
  return occurrence.roots.map((root: OccurrenceRoot): AcquisitionRoot =>
    root.source === 'git-worktree' ||
    (root.source === 'git' && root.worktree !== 'absent')
      ? { worktree: root.locator }
      : root.source === 'git'
        ? { git: root.locator }
        : root.locator,
  );
}

/** Captures the project as it is now. */
function observe(project: Project, roots: readonly AcquisitionRoot[]) {
  return importPaths(project.root, roots);
}

type Observation = Awaited<ReturnType<typeof observe>>;

async function shown(
  project: Project,
  artifact: ArtifactId,
  start: number,
  end: number,
) {
  const range = await readRange(
    artifactPath(project.artifacts, artifact),
    start,
    end,
    MAX_SHOWN_BYTES,
  );
  return { text: range.text, truncated: range.truncated };
}

/**
 * Checks one revision's page against an observation: every citation is
 * resolved again, and each one whose evidence no longer matches is returned
 * with the text it cited and the text now at that place.
 */
async function check(
  project: Project,
  revision: StateRevision,
  page: string,
  observed: Observation,
) {
  const occurrence = await readStoredOccurrence(
    project.occurrences,
    observed.occurrenceId,
  );
  const now = await resolveReferences(
    project,
    occurrence,
    extractLocators(page),
  );
  const before = new Map(
    revision.references.map((reference) => [reference.locator, reference]),
  );
  const current = new Map(
    now.map((reference) => [reference.locator, reference]),
  );
  const changed = [];
  for (const item of await changedCitations(project, revision, now, page)) {
    const old = before.get(item.locator);
    const fresh = current.get(item.locator);
    changed.push({
      ...item,
      cited:
        old?.status === 'resolved'
          ? await shown(project, old.artifact, old.startByte, old.endByte)
          : undefined,
      current:
        fresh?.status === 'resolved'
          ? await shown(project, fresh.artifact, fresh.startByte, fresh.endByte)
          : {
              reason: fresh?.status === 'unresolved' ? fresh.reason : undefined,
            },
    });
  }
  const unresolved = revision.references.flatMap((reference) =>
    reference.status === 'unresolved'
      ? [{ locator: reference.locator, reason: reference.reason }]
      : [],
  );
  return { changed, unresolved };
}

function describe(observed: Observation) {
  return { occurrence: observed.occurrenceId, roots: observed.roots };
}

/** Text shaped like a locator, which is a citation only inside backticks. */
const BARE_LOCATOR =
  /(?<![\w/.-])r[1-9][0-9]*(?:\/[^\s`#]+)?#L[0-9]+(?:-L[0-9]+)?(?![\w-])/g;

/**
 * Locators written outside code spans. A page records only code spans as
 * citations, so these would be recorded as plain text, citing nothing.
 */
function bareLocators(page: string) {
  const found = new Set<string>();
  for (const line of page.split('\n')) {
    for (const match of line
      .replace(/`[^`\n]+`/g, ' ')
      .matchAll(BARE_LOCATOR)) {
      found.add(match[0]);
    }
  }
  return [...found];
}

/**
 * Where the project stands, checked against the project as it is now. Each head
 * revision is returned with its page and with every citation whose evidence no
 * longer matches the current project, before anyone relies on it. Nothing is
 * changed: the state is not repaired and no citation is retargeted. The only
 * thing written is the observation itself.
 */
export async function orient(directory: string) {
  const project = await loadProject(directory);
  const revisions = await readAllStates(project);
  const heads = headsOf(revisions);
  // Named as the caller named it, so the command works from where it was run.
  const command = `sulai record ${/\s/.test(directory) ? JSON.stringify(directory) : directory} -`;
  if (heads.length === 0) {
    const observed = await observe(project, await rootsFor(project, undefined));
    return {
      project: project.root,
      observed: [describe(observed)],
      heads: [],
      next: `No state is recorded yet. Write a page saying where the project stands, cite the evidence for each claim as \`r1/<path>#L<first>-L<last>\` (roots are listed under "observed"), and record it with: ${command}`,
    };
  }
  // Heads recorded against the same roots share one observation.
  const observations = new Map<string, Observation>();
  const results = [];
  for (const id of heads) {
    const revision = revisions.get(id) as StateRevision;
    const roots = await rootsFor(project, revision);
    const key = JSON.stringify(roots);
    let observed = observations.get(key);
    if (observed === undefined) {
      observed = await observe(project, roots);
      observations.set(key, observed);
    }
    const page = await readPage(project, revision.page);
    results.push({
      revision: id,
      parent: revision.parent,
      createdAt: revision.createdAt,
      page,
      observed: observed.occurrenceId,
      ...(await check(project, revision, page, observed)),
    });
  }
  const moved = results.reduce((sum, head) => sum + head.changed.length, 0);
  return {
    project: project.root,
    observed: [...observations.values()].map(describe),
    heads: results,
    next:
      (moved > 0
        ? `${moved} citation(s) no longer match the current project; each is listed under "changed" with the text it cited and the text there now. What the change means is yours to judge. A next page that keeps one of these citations is recorded with --allow-changed-citations. `
        : 'Every citation still matches the current project. ') +
      (heads.length > 1
        ? `There are ${heads.length} heads; record the next page with --parent naming the one it continues: ${command} --parent <revision>`
        : `After changing what the project holds, write the next page from this one, changing only the lines that changed, and record it with: ${command}`),
  };
}

/**
 * Records the next revision against a fresh observation of the project, so its
 * citations resolve against what the writer read, committed or not. The parent
 * is the one head, or the one named. A locator written without its backticks
 * is refused, since it would cite nothing. A citation kept from the parent that
 * now cites different text is refused as `sulai state record` refuses it.
 */
export async function recordNext(
  directory: string,
  pageSource: string | Uint8Array,
  options: {
    readonly parent?: unknown;
    readonly allowChangedCitations?: boolean;
  } = {},
) {
  const project = await loadProject(directory);
  const revisions = await readAllStates(project);
  let parent: StateId | undefined;
  if (options.parent !== undefined) {
    parent = parseStateId(options.parent);
    if (!revisions.has(parent)) {
      throw new ValidationError('The named parent state is not stored');
    }
  } else {
    const heads = headsOf(revisions);
    if (heads.length > 1) {
      throw new ValidationError(
        `There are ${heads.length} heads; name the one this page continues with --parent: ${heads.join(', ')}`,
      );
    }
    parent = heads[0];
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
  const bare = bareLocators(page);
  if (bare.length > 0) {
    throw new ValidationError(
      `${bare.length} citation(s) are not in backticks, so they would be recorded as plain text, citing nothing:\n  ${bare.join('\n  ')}\nPut each one in backticks, as \`r1/<path>#L<first>-L<last>\`.`,
    );
  }
  const observed = await observe(
    project,
    await rootsFor(
      project,
      parent === undefined ? undefined : revisions.get(parent),
    ),
  );
  const recorded = await recordState(
    project.root,
    bytes,
    observed.occurrenceId,
    parent,
    { allowChangedCitations: options.allowChangedCitations === true },
  );
  return { ...recorded, observed: describe(observed) };
}
