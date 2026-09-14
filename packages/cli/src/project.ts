import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CONVERSATION_FORMAT,
  MAX_CONVERSATION_BYTES,
  importConversation,
  parseArtifactId,
  ValidationError,
} from '@sulai/core';
import type { ImportedConversation } from '@sulai/core';

const PROJECT_FORMAT = 'sulai.project';
const PROJECT_VERSION = 1;
const PROJECT_FILE = Buffer.from(
  JSON.stringify({
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    artifactFormat: CONVERSATION_FORMAT,
  }) + '\n',
);

function paths(directory: string) {
  const root = resolve(directory);
  const store = join(root, '.sulai');
  return {
    root,
    store,
    artifacts: join(store, 'artifacts'),
    temporary: join(store, 'tmp'),
    marker: join(store, 'project.json'),
  };
}

async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ValidationError('Project storage must use regular directories');
  }
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new ValidationError(
      'Input must be a regular file, not a symbolic link',
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) {
      throw new ValidationError(`File must contain at most ${limit} bytes`);
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) return buffer.subarray(0, length);
      length += bytesRead;
      if (length > limit)
        throw new ValidationError(`File exceeds ${limit} bytes`);
    }
    throw new ValidationError(`File exceeds ${limit} bytes`);
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function removeTemporaryFile(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      if (!hasCode(error, 'EBUSY') || attempt === 3) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

async function writeImmutable(
  temporaryDirectory: string,
  destination: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const temporaryPath = join(temporaryDirectory, randomUUID());
  const handle = await open(temporaryPath, 'wx', 0o600);
  let created = true;
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // A hard link publishes complete bytes atomically without replacing an existing name.
      await link(temporaryPath, destination);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const existing = await readBounded(destination, bytes.byteLength);
      if (!existing.equals(Buffer.from(bytes))) {
        throw new ValidationError(
          'Existing stored bytes differ; refusing to overwrite',
        );
      }
      created = false;
    }
  } catch (error) {
    let cleanupFailure: { error: unknown } | undefined;
    try {
      await removeTemporaryFile(temporaryPath);
    } catch (cleanupError) {
      cleanupFailure = { error: cleanupError };
    }
    if (cleanupFailure) {
      const message = error instanceof Error ? error.message : 'Write failed';
      throw new AggregateError(
        [error, cleanupFailure.error],
        `${message}; temporary-file cleanup also failed`,
        { cause: error },
      );
    }
    throw error;
  }
  await removeTemporaryFile(temporaryPath);
  return created;
}

async function loadProject(directory: string) {
  const project = paths(directory);
  await assertDirectory(project.store);
  await assertDirectory(project.artifacts);
  await assertDirectory(project.temporary);
  const bytes = await readBounded(project.marker, 4096);
  if (!bytes.equals(PROJECT_FILE)) {
    throw new ValidationError('Invalid or unsupported project metadata');
  }
  return project;
}

export async function initializeProject(directory: string) {
  const project = paths(directory);
  await mkdir(project.root, { recursive: true });
  for (const path of [project.store, project.artifacts, project.temporary]) {
    await mkdir(path, { recursive: true });
    await assertDirectory(path);
  }
  const created = await writeImmutable(
    project.temporary,
    project.marker,
    PROJECT_FILE,
  );
  return { directory: project.root, created };
}

function summary(conversation: ImportedConversation) {
  return {
    id: conversation.artifact.id,
    byteLength: conversation.artifact.byteLength,
    messageCount: conversation.messages.length,
  };
}

export async function importConversationFile(
  directory: string,
  filename: string,
) {
  const project = await loadProject(directory);
  const bytes = await readBounded(resolve(filename), MAX_CONVERSATION_BYTES);
  const conversation = importConversation(bytes);
  const digest = conversation.artifact.id.slice('sha256:'.length);
  const created = await writeImmutable(
    project.temporary,
    join(project.artifacts, `${digest}.raw`),
    conversation.artifact.bytes(),
  );
  return { ...summary(conversation), created };
}

async function readArtifact(artifactsDirectory: string, value: unknown) {
  const id = parseArtifactId(value);
  const filename = `${id.slice('sha256:'.length)}.raw`;
  const bytes = await readBounded(
    join(artifactsDirectory, filename),
    MAX_CONVERSATION_BYTES,
  );
  const conversation = importConversation(bytes);
  if (conversation.artifact.id !== id) {
    throw new ValidationError(
      'Stored artifact hash does not match its identity',
    );
  }
  return conversation;
}

export async function inspectProject(directory: string) {
  const project = await loadProject(directory);
  const filenames = (await readdir(project.artifacts)).sort();
  const artifacts = [];
  for (const filename of filenames) {
    if (!/^[a-f0-9]{64}\.raw$/.test(filename)) {
      throw new ValidationError('Unexpected entry in the artifact store');
    }
    const conversation = await readArtifact(
      project.artifacts,
      `sha256:${filename.slice(0, -4)}`,
    );
    artifacts.push(summary(conversation));
  }
  return { artifacts };
}

export async function inspectArtifact(directory: string, value: unknown) {
  const project = await loadProject(directory);
  const conversation = await readArtifact(project.artifacts, value);
  const raw = conversation.artifact.bytes();
  return {
    ...summary(conversation),
    format: conversation.format,
    messages: conversation.messages.map((message) => ({
      ...message,
      rawSource: new TextDecoder('utf-8', { fatal: true }).decode(
        raw.subarray(message.sourceUnit.startByte, message.sourceUnit.endByte),
      ),
    })),
  };
}
