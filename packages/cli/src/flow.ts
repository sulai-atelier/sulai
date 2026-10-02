/**
 * The front door an agent uses (ADR 0011). `orient` observes the project,
 * checks the current state against what it observed, and only then serves the
 * state. `recordNext` observes again and records the next revision against
 * that observation. Both are built only from acquisition, resolution and
 * recording; neither decides what a change means. Between them, the agent
 * edits the next page in a draft Sulai keeps (ADR 0013).
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
import { draftPath, readDraft, writeDraft } from './draft.js';
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

/** One line with its citation, as a page should have it. */
const EXAMPLE = 'Lists sort by date. `r1/src/config.js#L3`';

/** A command as the caller would type it, from where it was run. */
const named = (directory: string) =>
  /\s/.test(directory) ? JSON.stringify(directory) : directory;

/**
 * Opens the project, or says how to create it. The front door names the next
 * step rather than leave an agent with a bare file-not-found error.
 */
async function openProject(directory: string) {
  if (!existsSync(join(resolve(directory), '.sulai'))) {
    throw new ValidationError(
      `${directory} has no Sulai store yet. Create it with: sulai init ${named(directory)}`,
    );
  }
  return loadProject(directory);
}

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
  const project = await openProject(directory);
  const revisions = await readAllStates(project);
  const heads = headsOf(revisions);
  // Named as the caller named it, so the command works from where it was run.
  const command = `sulai record ${named(directory)}`;
  const shownDraft = join(directory, '.sulai', 'draft.md');
  if (heads.length === 0) {
    const observed = await observe(project, await rootsFor(project, undefined));
    const draft = await keepDraft(project, null, Buffer.alloc(0));
    return {
      project: project.root,
      observed: [describe(observed)],
      heads: [],
      draft: { path: draftPath(project), ...draft },
      next:
        draft.state === 'ready'
          ? `No state is recorded yet. Write a page in ${shownDraft} saying where the project stands, with the evidence for each claim cited in backticks after it, as in: ${EXAMPLE} (roots are listed under "observed"). Then record it with: ${command}`
          : `No state is recorded yet. ${draftNote(draft, shownDraft, command)}`,
    };
  }
  // Heads recorded against the same roots share one observation.
  const observations = new Map<string, Observation>();
  const results = [];
  const pages = new Map<StateId, string>();
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
    pages.set(id, page);
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
  // A citation that never resolved was never checked, so it cannot be said to
  // still match.
  const unresolved = results.reduce(
    (sum, head) => sum + head.unresolved.length,
    0,
  );
  const head = heads.length === 1 ? (heads[0] as StateId) : undefined;
  const draft =
    head === undefined
      ? await draftAmong(project, heads)
      : await keepDraft(
          project,
          head,
          Buffer.from(pages.get(head) as string, 'utf8'),
        );
  return {
    project: project.root,
    observed: [...observations.values()].map(describe),
    heads: results,
    draft: { path: draftPath(project), ...draft },
    next:
      (moved > 0
        ? `${moved} citation(s) no longer match the current project; each is listed under "changed" with the text it cited and the text there now. What the change means is yours to judge. A next page that keeps one of these citations is recorded with --allow-changed-citations. `
        : unresolved > 0
          ? 'No resolved citation has moved. '
          : 'Every citation still matches the current project. ') +
      (unresolved > 0
        ? `${unresolved} citation(s) were unresolved when the state was recorded, listed under "unresolved" with the reason. `
        : '') +
      (heads.length > 1
        ? `There are ${heads.length} heads, so no draft is chosen for you. Record the next page with --parent naming the one it continues: ${command} <page|-> --parent <revision>`
        : draft.state === 'ready'
          ? `The current page is in ${shownDraft}. After changing what the project holds, edit it there, changing only the lines that changed and citing in backticks as in: ${EXAMPLE}. Then record it with: ${command}`
          : draftNote(draft, shownDraft, command)),
  };
}

type DraftReport = {
  /** `ready`: Sulai wrote it; `kept`: unrecorded edits begun from the head;
   * `behind`: unrecorded edits begun elsewhere; `none`: no draft;
   * `unavailable`: it could not be read or written. */
  readonly state: 'ready' | 'kept' | 'behind' | 'none' | 'unavailable';
  /** The state it began from, null before any, or undefined when unknown. */
  readonly began?: StateId | null | undefined;
  readonly reason?: string;
};

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Keeps the draft for one head, or for none: it is written only when it holds
 * no one's work, being absent or exactly what Sulai last wrote. Unrecorded
 * edits are never overwritten.
 */
async function keepDraft(
  project: Project,
  head: StateId | null,
  page: Buffer,
): Promise<DraftReport> {
  // The draft is a convenience. A failure to keep it never stops the state
  // from being checked and served.
  try {
    const draft = await readDraft(project);
    if (draft === null || !draft.edited) {
      await writeDraft(project, page, head);
      return { state: 'ready', began: head };
    }
    return {
      state: draft.base === head ? 'kept' : 'behind',
      began: draft.base,
    };
  } catch (error) {
    return { state: 'unavailable', reason: reasonOf(error) };
  }
}

/** With several heads no draft is chosen; one already there is left alone. */
async function draftAmong(
  project: Project,
  heads: readonly StateId[],
): Promise<DraftReport> {
  let draft;
  try {
    draft = await readDraft(project);
  } catch (error) {
    return { state: 'unavailable', reason: reasonOf(error) };
  }
  if (draft === null) return { state: 'none' };
  return {
    state:
      draft.base !== undefined &&
      draft.base !== null &&
      heads.includes(draft.base)
        ? 'kept'
        : 'behind',
    began: draft.base,
  };
}

function draftNote(draft: DraftReport, shown: string, command: string) {
  if (draft.state === 'unavailable') {
    return `The draft in ${shown} could not be kept (${draft.reason}). Record the next page from a file or standard input instead: ${command} <page|->`;
  }
  if (draft.state === 'kept') {
    return `Your unrecorded edits in ${shown} were kept. Record them with: ${command}`;
  }
  const began =
    draft.began === undefined
      ? 'an unknown state'
      : (draft.began ?? 'no state');
  return `The draft in ${shown} holds unrecorded edits begun from ${began}, not from the current head, so it was kept, not replaced. Bring it up to date from the page above, then record it with: ${command} --parent <the state it continues>`;
}

/**
 * Records the next revision against a fresh observation of the project, so its
 * citations resolve against what the writer read, committed or not. The parent
 * is the one head, or the one named. A locator written without its backticks
 * is refused, since it would cite nothing. A citation kept from the parent that
 * now cites different text is refused as `sulai state record` refuses it.
 *
 * With no page, the draft is recorded (ADR 0013). It must have begun from the
 * head it continues, unless the parent is named, and must hold something the
 * agent wrote. After a revision is recorded, the draft holds its page, unless
 * the page came from elsewhere and the draft holds unrecorded edits.
 */
export async function recordNext(
  directory: string,
  pageSource?: string | Uint8Array,
  options: {
    readonly parent?: unknown;
    readonly allowChangedCitations?: boolean;
  } = {},
) {
  const project = await openProject(directory);
  const revisions = await readAllStates(project);
  const fromDraft = pageSource === undefined;
  // Recording a page given directly does not depend on the draft, so a draft
  // that cannot be read only means it is left alone afterwards.
  let draft: Awaited<ReturnType<typeof readDraft>> | 'unreadable';
  try {
    draft = await readDraft(project);
  } catch (error) {
    if (fromDraft) throw error;
    draft = 'unreadable';
  }
  if (fromDraft && (draft === null || draft === 'unreadable')) {
    throw new ValidationError(
      `There is no draft to record. Run sulai orient ${named(directory)}, which writes one, or give a page.`,
    );
  }
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
    // An old draft must not silently continue a newer head.
    if (
      fromDraft &&
      draft !== null &&
      draft !== 'unreadable' &&
      draft.base !== (parent ?? null)
    ) {
      throw new ValidationError(
        draft.base === undefined
          ? 'Where the draft began is not known. Name the state it continues with --parent.'
          : `The draft began from ${draft.base ?? 'no state'}, but the head is now ${parent ?? 'none'}. Bring it up to date from the current page, then record it with --parent naming the state it continues.`,
      );
    }
  }
  const bytes = fromDraft
    ? (draft as { bytes: Buffer }).bytes
    : typeof pageSource === 'string'
      ? await readBounded(resolve(pageSource), MAX_STATE_PAGE_BYTES)
      : Buffer.from(pageSource as Uint8Array);
  if (fromDraft && bytes.byteLength === 0) {
    throw new ValidationError(
      `The draft is empty. Write the page in ${join(directory, '.sulai', 'draft.md')} first.`,
    );
  }
  if (
    fromDraft &&
    (draft as { edited: boolean }).edited === false &&
    parent !== undefined
  ) {
    throw new ValidationError(
      'The draft is unchanged from the page it began from, so there is nothing new to record. Edit it first.',
    );
  }
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
      `${bare.length} citation(s) are not in backticks, so they would be recorded as plain text, citing nothing:\n  ${bare.join('\n  ')}\nPut each one in backticks after its claim, as in: ${EXAMPLE}`,
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
  // The draft moves on to the page just recorded, unless it holds edits that
  // this record did not take. The revision is recorded by now, so a failure
  // here is reported, never thrown: it must not look as if recording failed.
  let refreshed = false;
  let reason: string | undefined;
  if (
    draft !== 'unreadable' &&
    (fromDraft || draft === null || !draft.edited)
  ) {
    try {
      await writeDraft(project, bytes, recorded.id);
      refreshed = true;
    } catch (error) {
      reason = reasonOf(error);
    }
  }
  return {
    ...recorded,
    observed: describe(observed),
    draft: {
      path: draftPath(project),
      refreshed,
      ...(reason === undefined
        ? {}
        : {
            reason,
            note: 'The revision was recorded, but the draft could not be updated. It still holds what it held, so recording it again is refused until it is brought up to date.',
          }),
    },
  };
}
