#!/usr/bin/env node
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
  projectStatus,
  recordState,
} from './project.js';

const usage = `Usage:
  sulai init <directory>
  sulai import <directory> <path>...           preserve files or directories and
                                               record the acquisition as one
                                               occurrence, one root per path
  sulai state record <directory> <page> --from <occurrence-id> [--parent <state-id>]
                                               record a state page and exactly
                                               what evidence it cites
  sulai status <directory>                     the current state, one page per head
  sulai why <directory> <state-id> <line>      the preserved evidence behind one
                                               line of a state page
  sulai diff <directory> <state-id> <state-id> how the state page changed
  sulai inspect <directory> [id]               verify stored identity and integrity
                                               of the project, an artifact, an
                                               occurrence, or a state
  sulai interpret <directory> <artifact-id>    read an artifact as a conversation

Experimental, unstable, may be removed:
  sulai experimental claude-code-session <directory> <artifact-id>
                                               structure of a Claude Code local
                                               session transcript, never its text

Import preserves any bytes and records one occurrence: what it attempted, the
exact bytes each input became, and what it could not capture and why. It reads
only the paths given, which must not overlap; it never follows links. A partial
acquisition still prints its record and exits with status 3.

A state revision records a view of where a project stands and what it cites:
each reference, written \`rN/path#La-Lb\` against one occurrence, is resolved to
exact bytes or recorded as unresolved. Sulai checks the pointer, never the claim.

Interpretation is a separate step, so material that no current reader
understands is still stored faithfully and can be re-derived later. The only
stable interpreter today is the synthetic sulai.conversation.v1 format.
`;

/** Exit status for an acquisition that recorded inputs it could not capture. */
const PARTIAL_ACQUISITION = 3;

/** Splits `--name value` options from positional arguments. */
function options(args: string[], allowed: readonly string[]) {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
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
  return { positional, named };
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
    result = await initializeProject(directory);
  } else if (
    command === 'import' &&
    directory !== undefined &&
    args.length >= 3
  ) {
    const imported = await importPaths(directory, args.slice(2));
    skipped = imported.skipped.length;
    result = imported;
  } else if (command === 'state' && args[1] === 'record') {
    const { positional, named } = options(args.slice(2), ['from', 'parent']);
    const from = named.get('from');
    if (positional.length !== 2 || from === undefined) {
      throw new Error(usage.trimEnd());
    }
    result = await recordState(
      positional[0] as string,
      positional[1] as string,
      from,
      named.get('parent'),
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
