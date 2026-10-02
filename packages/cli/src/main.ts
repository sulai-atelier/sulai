#!/usr/bin/env node
import { MAX_STATE_PAGE_BYTES } from '@sulai/core';
import { readClaudeCodeSessionArtifact } from './experimental.js';
import {
  diffStates,
  explainLine,
  importPaths,
  initializeProject,
  inspectArtifact,
  inspectOccurrence,
  inspectProject,
  inspectState,
  interpretConversation,
  orient,
  projectStatus,
  recordNext,
  recordState,
  upgradeProject,
} from './index.js';
import type { AcquisitionRoot } from './index.js';

const usage = `Usage:
  sulai init <directory>                       once, to create the project's store
  sulai orient <directory>                     where the project stands: observes the
                                               project, checks the current state's
                                               citations against it, and prints the
                                               state with every citation whose
                                               evidence moved
  sulai record <directory> <page|->            record the next page, from a file or
               [--parent <state-id>]           standard input, against the project
               [--allow-changed-citations]     as it is now
               [--allow-uncommitted]

These three are how the agent working on a project keeps its state. Write each
page from the previous one, changing only the lines that changed. Cite the
evidence for each claim as \`r1/<path>#L<first>-L<last>\`, against the roots
orient lists. In a Git project the committed files are the evidence, so commit
what a citation points at before recording. Sulai reports what moved; it never
decides what a change means or repairs the state.

Every command:
  sulai init <directory>
  sulai import <directory> <root>... [--allow-uncommitted]
                                               preserve every root and record
                                               the acquisition as one occurrence;
                                               a root is a file or directory
                                               path, or --git <repository> for
                                               the commit at its HEAD
  sulai state record <directory> <page> --from <occurrence-id>
                     [--parent <state-id>] [--allow-changed-citations]
                                               record a state page, or - to read
                                               it from standard input, and
                                               exactly what evidence it cites
  sulai status <directory>                     the current state, one page per head,
                                               as recorded and unchecked
  sulai why <directory> <state-id> <line>      the preserved evidence behind one
                                               line of a state page
  sulai diff <directory> <state-id> <state-id> how the state page changed
  sulai inspect <directory> [id]               verify stored identity and integrity
                                               of the project, an artifact, an
                                               occurrence, or a state
  sulai interpret <directory> <artifact-id>    read an artifact as a conversation
  sulai upgrade <directory>                    verify a storage format 4 project,
                                               then mark it format 5

Experimental, unstable, may be removed:
  sulai experimental claude-code-session <directory> <artifact-id>
                                               structure of a Claude Code local
                                               session transcript, never its text

Import preserves any bytes and records one occurrence: what it attempted, the
exact bytes each input became, and what it could not capture and why. It reads
only the paths given, which must not overlap; it never follows links. A partial
acquisition still prints its record and exits with status 3.

With --git, import reads the commit at the repository's HEAD through Git, not
the working folder: every tracked file as committed, and nothing untracked or
ignored. It never fetches. It is refused while the working tree differs from
that commit, unless --allow-uncommitted is given.

A state revision records a view of where a project stands and what it cites:
each reference, written \`rN/path#La-Lb\` against one occurrence, is resolved to
exact bytes or recorded as unresolved. Sulai checks the pointer, never the claim.
A citation kept from the parent revision must still cite the same text; if its
file changed so that it no longer does, recording is refused unless
--allow-changed-citations is given.

Interpretation is a separate step, so material that no current reader
understands is still stored faithfully and can be re-derived later. The only
stable interpreter today is the synthetic sulai.conversation.v1 format.
`;

/** Exit status for an acquisition that recorded inputs it could not capture. */
const PARTIAL_ACQUISITION = 3;

/**
 * Splits `--name value` options and `--flag` switches from positional
 * arguments. A lone `-` is positional: it names standard input.
 */
function options(
  args: string[],
  allowed: readonly string[],
  switches: readonly string[] = [],
) {
  const positional: string[] = [];
  const named = new Map<string, string>();
  const set = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (switches.includes(name) && !set.has(name)) {
        set.add(name);
        continue;
      }
      const value = args[index + 1];
      if (!allowed.includes(name) || value === undefined || named.has(name)) {
        throw new Error(usage.trimEnd());
      }
      named.set(name, value);
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, named, switches: set };
}

/** Reads standard input, refusing more than `limit` bytes. */
async function readStandardInput(limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > limit) {
      throw new Error(`A state page must contain at most ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main(args: string[]): Promise<void> {
  if (
    args[0] === 'experimental' &&
    args[1] === 'claude-code-session' &&
    args.length === 4
  ) {
    const result = await readClaudeCodeSessionArtifact(
      args[2] as string,
      args[3],
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const [command, directory, operand] = args;
  if (args.length === 0 || (args.length === 1 && command === '--help')) {
    process.stdout.write(usage);
    return;
  }
  let result: unknown;
  let skipped = 0;
  if (command === 'init' && directory !== undefined && args.length === 2) {
    result = {
      ...(await initializeProject(directory)),
      next: `See where the project stands with: sulai orient ${directory}`,
    };
  } else if (
    command === 'import' &&
    directory !== undefined &&
    args.length >= 3
  ) {
    // Roots keep the order given, so paths and --git roots number together.
    const roots: AcquisitionRoot[] = [];
    let allowUncommitted = false;
    for (let index = 2; index < args.length; index += 1) {
      const arg = args[index] as string;
      const repository = args[index + 1];
      if (arg === '--git' && repository !== undefined) {
        roots.push({ git: repository });
        index += 1;
      } else if (arg === '--allow-uncommitted' && !allowUncommitted) {
        allowUncommitted = true;
      } else if (arg.startsWith('--')) {
        throw new Error(usage.trimEnd());
      } else {
        roots.push(arg);
      }
    }
    if (roots.length === 0) throw new Error(usage.trimEnd());
    const imported = await importPaths(directory, roots, { allowUncommitted });
    skipped = imported.skipped.length;
    result = imported;
  } else if (command === 'state' && args[1] === 'record') {
    const { positional, named, switches } = options(
      args.slice(2),
      ['from', 'parent'],
      ['allow-changed-citations'],
    );
    const from = named.get('from');
    if (positional.length !== 2 || from === undefined) {
      throw new Error(usage.trimEnd());
    }
    const page = positional[1] as string;
    result = await recordState(
      positional[0] as string,
      page === '-' ? await readStandardInput(MAX_STATE_PAGE_BYTES) : page,
      from,
      named.get('parent'),
      { allowChangedCitations: switches.has('allow-changed-citations') },
    );
  } else if (
    command === 'orient' &&
    directory !== undefined &&
    args.length === 2
  ) {
    result = await orient(directory);
  } else if (command === 'record') {
    const { positional, named, switches } = options(
      args.slice(1),
      ['parent'],
      ['allow-changed-citations', 'allow-uncommitted'],
    );
    if (positional.length !== 2) throw new Error(usage.trimEnd());
    const page = positional[1] as string;
    result = await recordNext(
      positional[0] as string,
      page === '-' ? await readStandardInput(MAX_STATE_PAGE_BYTES) : page,
      {
        parent: named.get('parent'),
        allowChangedCitations: switches.has('allow-changed-citations'),
        allowUncommitted: switches.has('allow-uncommitted'),
      },
    );
  } else if (
    command === 'status' &&
    directory !== undefined &&
    args.length === 2
  ) {
    result = await projectStatus(directory);
  } else if (
    command === 'why' &&
    directory !== undefined &&
    args.length === 4
  ) {
    result = await explainLine(directory, args[2], args[3]);
  } else if (
    command === 'diff' &&
    directory !== undefined &&
    args.length === 4
  ) {
    result = await diffStates(directory, args[2], args[3]);
  } else if (
    command === 'inspect' &&
    directory !== undefined &&
    args.length >= 2 &&
    args.length <= 3
  ) {
    result =
      operand === undefined
        ? await inspectProject(directory)
        : operand.startsWith('occurrence:')
          ? await inspectOccurrence(directory, operand)
          : operand.startsWith('state:')
            ? await inspectState(directory, operand)
            : await inspectArtifact(directory, operand);
  } else if (
    command === 'interpret' &&
    directory !== undefined &&
    operand !== undefined &&
    args.length === 3
  ) {
    result = await interpretConversation(directory, operand);
  } else if (
    command === 'upgrade' &&
    directory !== undefined &&
    args.length === 2
  ) {
    result = await upgradeProject(directory);
  } else {
    throw new Error(usage.trimEnd());
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (skipped > 0) {
    process.stderr.write(
      `sulai: partial acquisition: ${skipped} input(s) could not be captured; see "skipped"\n`,
    );
    process.exitCode = PARTIAL_ACQUISITION;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unexpected failure';
  process.stderr.write(`sulai: ${message}\n`);
  process.exitCode = 1;
}
