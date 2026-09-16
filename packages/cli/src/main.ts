#!/usr/bin/env node
import {
  importArtifactFile,
  initializeProject,
  inspectArtifact,
  inspectProject,
  interpretConversation,
} from './project.js';

const usage = `Usage:
  sulai init <directory>
  sulai import <directory> <file>              store exact bytes, no interpretation
  sulai inspect <directory> [artifact-id]      verify stored identity and integrity
  sulai interpret <directory> <artifact-id>    read an artifact as a conversation

Import preserves any bytes. Interpretation is a separate step, so material that
no current reader understands is still stored faithfully and can be re-derived
later. The only interpreter today is the synthetic sulai.conversation.v1 format.
`;

async function main(args: string[]): Promise<void> {
  const [command, directory, operand] = args;
  if (args.length === 0 || (args.length === 1 && command === '--help')) {
    process.stdout.write(usage);
    return;
  }
  let result: unknown;
  if (command === 'init' && directory !== undefined && args.length === 2) {
    result = await initializeProject(directory);
  } else if (
    command === 'import' &&
    directory !== undefined &&
    operand !== undefined &&
    args.length === 3
  ) {
    result = await importArtifactFile(directory, operand);
  } else if (
    command === 'inspect' &&
    directory !== undefined &&
    args.length >= 2 &&
    args.length <= 3
  ) {
    result =
      operand === undefined
        ? await inspectProject(directory)
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
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unexpected failure';
  process.stderr.write(`sulai: ${message}\n`);
  process.exitCode = 1;
}
