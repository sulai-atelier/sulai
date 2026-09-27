#!/usr/bin/env node
import { readClaudeCodeSessionArtifact } from './experimental.js';
import {
  importPaths,
  initializeProject,
  inspectArtifact,
  inspectOccurrence,
  inspectProject,
  interpretConversation,
} from './project.js';

const usage = `Usage:
  sulai init <directory>
  sulai import <directory> <path>...           preserve files or directories and
                                               record the acquisition as one
                                               occurrence, one root per path
  sulai inspect <directory> [id]               verify stored identity and integrity
                                               of the project, an artifact, or an
                                               occurrence
  sulai interpret <directory> <artifact-id>    read an artifact as a conversation

Experimental, unstable, may be removed:
  sulai experimental claude-code-session <directory> <artifact-id>
                                               structure of a Claude Code local
                                               session transcript, never its text

Import preserves any bytes and records one occurrence: what it attempted, the
exact bytes each input became, and what it could not capture and why. It reads
only the paths given, which must not overlap; it never follows links. A partial acquisition still prints
its record and exits with status 3. Interpretation is a separate step, so
material that no current reader understands is still stored faithfully and can
be re-derived later. The only stable interpreter today is the synthetic
sulai.conversation.v1 format.
`;

/** Exit status for an acquisition that recorded inputs it could not capture. */
const PARTIAL_ACQUISITION = 3;

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
