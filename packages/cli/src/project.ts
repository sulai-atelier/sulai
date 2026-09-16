import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Artifact,
  importConversation,
  parseArtifactId,
  ValidationError,
} from '@sulai/core';
import type { ArtifactId, ImportedConversation } from '@sulai/core';

const PROJECT_FORMAT = 'sulai.project';
const PROJECT_VERSION = 2;

/**
 * The project marker describes the Sulai storage format only. It deliberately
 * says nothing about the format of the artifacts inside, because an artifact is
 * exact bytes of any kind. Version 1 embedded `artifactFormat` and is refused.
 */
const PROJECT_FILE = Buffer.from(
  JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION }) + '\n',
);

/**
 * A local-store policy, not a property of artifacts. Reads are fully buffered,
 * so this bounds memory rather than expressing a format limit. Real provider
 * exports run to hundreds of megabytes and will need streaming identity before
 * this ceiling can rise usefully.
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const STORE_MODE = 0o700;

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

function hasCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}

/**
 * Windows reports a locked file as EBUSY, EPERM or EACCES depending on which
 * component holds it (indexer, scanner, another handle), so all three are
 * treated as transient. ENOENT means the file is already gone, which is the
 * outcome this function wants.
 */
const TRANSIENT_UNLINK_CODES = ['EBUSY', 'EPERM', 'EACCES'] as const;

async function removeTemporaryFile(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return;
      if (!hasCode(error, ...TRANSIENT_UNLINK_CODES) || attempt === 3) {
        throw error;
      }
      await delay(100 * (attempt + 1));
    }
  }
}

async function writeImmutable(
  temporaryDirectory: string,
  destination: string,
  bytes: Uint8Array,
): Promise<boolean> {
  // The temporary directory is ephemeral, so recreate it rather than requiring
  // that a previous run left it behind.
  await mkdir(temporaryDirectory, { recursive: true, mode: STORE_MODE });
  await assertDirectory(temporaryDirectory);
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

function describeUnsupportedMarker(bytes: Buffer): string {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { format?: unknown }).format === PROJECT_FORMAT
    ) {
      const version = (parsed as { version?: unknown }).version;
      if (version !== PROJECT_VERSION) {
        return `Project uses storage format version ${String(version)}; this build requires version ${PROJECT_VERSION}. Pre-alpha does not migrate projects.`;
      }
    }
  } catch {
    // Fall through to the generic message below.
  }
  return 'Invalid or unsupported project metadata';
}

async function loadProject(directory: string) {
  const project = paths(directory);
  await assertDirectory(project.store);
  await assertDirectory(project.artifacts);
  // `.sulai/tmp` is ephemeral and is recreated on demand, so its absence does
  // not make a project invalid.
  const bytes = await readBounded(project.marker, 4096);
  if (!bytes.equals(PROJECT_FILE)) {
    throw new ValidationError(describeUnsupportedMarker(bytes));
  }
  return project;
}

export async function initializeProject(directory: string) {
  const project = paths(directory);
  await mkdir(project.root, { recursive: true });
  for (const path of [project.store, project.artifacts, project.temporary]) {
    await mkdir(path, { recursive: true, mode: STORE_MODE });
    await assertDirectory(path);
  }
  const created = await writeImmutable(
    project.temporary,
    project.marker,
    PROJECT_FILE,
  );
  return { directory: project.root, created };
}

function artifactPath(artifactsDirectory: string, id: ArtifactId): string {
  return join(artifactsDirectory, `${id.slice('sha256:'.length)}.raw`);
}

/**
 * Stores exact bytes. This performs no format interpretation at all: material
 * that no current adapter understands is still preserved faithfully, so a
 * later, better adapter can re-derive from the untouched original instead of
 * requiring the user to import again.
 */
export async function importArtifactFile(directory: string, filename: string) {
  const project = await loadProject(directory);
  const bytes = await readBounded(resolve(filename), MAX_ARTIFACT_BYTES);
  const artifact = new Artifact(bytes);
  const created = await writeImmutable(
    project.temporary,
    artifactPath(project.artifacts, artifact.id),
    artifact.bytes(),
  );
  return { id: artifact.id, byteLength: artifact.byteLength, created };
}

/**
 * Reads stored bytes and verifies that they still hash to the name they are
 * stored under. No format is assumed.
 */
async function readArtifact(
  artifactsDirectory: string,
  value: unknown,
): Promise<Artifact> {
  const id = parseArtifactId(value);
  const bytes = await readBounded(
    artifactPath(artifactsDirectory, id),
    MAX_ARTIFACT_BYTES,
  );
  const artifact = new Artifact(bytes);
  if (artifact.id !== id) {
    throw new ValidationError(
      'Stored artifact hash does not match its identity',
    );
  }
  return artifact;
}

function storedArtifactId(filename: string): ArtifactId {
  if (!/^[a-f0-9]{64}\.raw$/.test(filename)) {
    throw new ValidationError('Unexpected entry in the artifact store');
  }
  return parseArtifactId(`sha256:${filename.slice(0, -4)}`);
}

/**
 * Generic integrity check. Verifies every stored artifact against its own
 * identity without interpreting any of them as a conversation.
 */
export async function inspectProject(directory: string) {
  const project = await loadProject(directory);
  const filenames = (await readdir(project.artifacts)).sort();
  const artifacts = [];
  for (const filename of filenames) {
    const artifact = await readArtifact(
      project.artifacts,
      storedArtifactId(filename),
    );
    artifacts.push({ id: artifact.id, byteLength: artifact.byteLength });
  }
  return { format: PROJECT_FORMAT, version: PROJECT_VERSION, artifacts };
}

export async function inspectArtifact(directory: string, value: unknown) {
  const project = await loadProject(directory);
  const artifact = await readArtifact(project.artifacts, value);
  return { id: artifact.id, byteLength: artifact.byteLength };
}

function decodeUnit(
  artifact: Artifact,
  unit: { startByte: number; endByte: number },
): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    artifact.slice(unit.startByte, unit.endByte),
  );
}

/**
 * An interpretation, deliberately separate from storage. Preservation happened
 * at import; this reads stored bytes through one specific format and can be
 * changed or replaced without touching what was preserved.
 */
export async function interpretConversation(directory: string, value: unknown) {
  const project = await loadProject(directory);
  const artifact = await readArtifact(project.artifacts, value);
  const conversation: ImportedConversation = importConversation(
    artifact.bytes(),
  );
  return {
    id: artifact.id,
    byteLength: artifact.byteLength,
    format: conversation.format,
    messageCount: conversation.messages.length,
    messages: conversation.messages.map((message) => ({
      ...message,
      rawSource: decodeUnit(artifact, message.sourceUnit),
    })),
  };
}
