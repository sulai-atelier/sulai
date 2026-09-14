#!/usr/bin/env node
import {
  importConversationFile,
  initializeProject,
  inspectArtifact,
  inspectProject,
} from './project.js';

const usage = `Usage:
  sulai init <directory>
  sulai import <directory> <conversation.jsonl>
  sulai inspect <directory> [artifact-id]

Imports support only the synthetic sulai.conversation.v1 format.
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
    result = await importConversationFile(directory, operand);
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
