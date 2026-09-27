import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Artifact,
  MAX_CONVERSATION_BYTES,
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
 * The most memory any streaming read holds, whatever the size of the artifact.
 * Preservation and verification both stream, so there is no storage size
 * ceiling: the real constraint is disk space, and running out of it fails and
 * cleans up like any other write error.
 */
export const STREAM_CHUNK_BYTES = 1024 * 1024;

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

async function openRegularFile(path: string): Promise<FileHandle> {
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
    if (!(await handle.stat()).isFile()) {
      throw new ValidationError(
        'Input must be a regular file, not a symbolic link',
      );
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

/**
 * Refuses a file whose size changed between being opened and being read to the
 * end. This detects growth and truncation only. Another process overwriting
 * bytes in place at the same length is not detected, so this is not an atomic
 * snapshot of a live file: Sulai reads files that have finished being written.
 */
function assertUnchangedSize(observed: number, expected: number): void {
  if (observed !== expected) {
    throw new ValidationError('File changed size while it was being read');
  }
}

/**
 * Yields bytes in bounded chunks from the current file position. The buffer is
 * reused, so a chunk is valid only until the next one is requested; every
 * consumer here hashes and writes it before asking for more.
 */
async function* readChunks(handle: FileHandle): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.alloc(STREAM_CHUNK_BYTES);
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) return;
    yield buffer.subarray(0, bytesRead);
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );
    if (bytesWritten === 0) {
      throw new Error('Write made no progress');
    }
    offset += bytesWritten;
  }
}

/**
 * Streams a file through SHA-256 without holding it in memory, returning the
 * identity its bytes would have as an artifact.
 */
async function hashFile(
  path: string,
): Promise<{ id: ArtifactId; byteLength: number }> {
  const handle = await openRegularFile(path);
  try {
    const expected = (await handle.stat()).size;
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of readChunks(handle)) {
      hash.update(chunk);
      byteLength += chunk.byteLength;
    }
    assertUnchangedSize(byteLength, expected);
    return { id: parseArtifactId(`sha256:${hash.digest('hex')}`), byteLength };
  } finally {
    await handle.close();
  }
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const handle = await openRegularFile(path);
  try {
    const stat = await handle.stat();
    if (stat.size > limit) {
      throw new ValidationError(`File must contain at most ${limit} bytes`);
    }
    // Allocate for the size actually observed, plus one byte so that growth
    // during the read is still detected.
    const expected = stat.size;
    const buffer = Buffer.alloc(expected + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    assertUnchangedSize(length, expected);
    return buffer.subarray(0, length);
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

/**
 * Removes a temporary file after a failure and returns the error to throw. If
 * cleanup also fails, both causes are kept rather than the first being lost.
 */
async function cleanupAfterFailure(
  error: unknown,
  temporaryPath: string,
): Promise<unknown> {
  try {
    await removeTemporaryFile(temporaryPath);
  } catch (cleanupError) {
    const message = error instanceof Error ? error.message : 'Write failed';
    return new AggregateError(
      [error, cleanupError],
      `${message}; temporary-file cleanup also failed`,
      { cause: error },
    );
  }
  return error;
}

async function prepareTemporaryDirectory(path: string): Promise<void> {
  // The temporary directory is ephemeral, so recreate it rather than requiring
  // that a previous run left it behind.
  await mkdir(path, { recursive: true, mode: STORE_MODE });
  await assertDirectory(path);
}

/**
 * Publishes a small, fixed byte sequence under a fixed name, refusing to replace
 * different existing content. Used for the project marker, whose name is not a
 * content hash.
 */
async function writeImmutable(
  temporaryDirectory: string,
  destination: string,
  bytes: Uint8Array,
): Promise<boolean> {
  await prepareTemporaryDirectory(temporaryDirectory);
  const temporaryPath = join(temporaryDirectory, randomUUID());
  let created = true;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
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
    throw await cleanupAfterFailure(error, temporaryPath);
  }
  await removeTemporaryFile(temporaryPath);
  return created;
}

interface StagedArtifact {
  readonly temporaryPath: string;
  readonly id: ArtifactId;
  readonly byteLength: number;
}

/**
 * Streams a source file into a new temporary file, hashing as it goes, so the
 * identity is known once the last byte is written and no more than one chunk is
 * ever in memory. The temporary file is synced before this returns.
 */
async function stageIntoTemporary(
  temporaryDirectory: string,
  sourcePath: string,
): Promise<StagedArtifact> {
  await prepareTemporaryDirectory(temporaryDirectory);
  const source = await openRegularFile(sourcePath);
  const temporaryPath = join(temporaryDirectory, randomUUID());
  try {
    const expected = (await source.stat()).size;
    const hash = createHash('sha256');
    let byteLength = 0;
    const target = await open(temporaryPath, 'wx', 0o600);
    try {
      for await (const chunk of readChunks(source)) {
        hash.update(chunk);
        await writeAll(target, chunk);
        byteLength += chunk.byteLength;
      }
      await target.sync();
    } finally {
      await target.close();
    }
    assertUnchangedSize(byteLength, expected);
    return {
      temporaryPath,
      id: parseArtifactId(`sha256:${hash.digest('hex')}`),
      byteLength,
    };
  } catch (error) {
    throw await cleanupAfterFailure(error, temporaryPath);
  } finally {
    await source.close();
  }
}

/**
 * Publishes a staged artifact under its content address without replacing
 * anything. If that address is already taken, the stored file is re-hashed by
 * streaming rather than trusted by its name, so a corrupt file under the right
 * name is refused instead of being reported as a successful duplicate.
 */
async function publishArtifact(
  staged: StagedArtifact,
  destination: string,
): Promise<boolean> {
  try {
    // A hard link publishes complete bytes atomically without replacing an existing name.
    await link(staged.temporaryPath, destination);
    return true;
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  const existing = await hashFile(destination);
  if (existing.id !== staged.id) {
    throw new ValidationError(
      'Existing stored bytes differ; refusing to overwrite',
    );
  }
  return false;
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
  // Validate an existing marker before attempting to publish a new one.
  // Without this, initializing over an incompatible project reports a
  // byte-count mismatch from the publish path rather than naming the version.
  try {
    const existing = await readBounded(project.marker, 4096);
    if (!existing.equals(PROJECT_FILE)) {
      throw new ValidationError(describeUnsupportedMarker(existing));
    }
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
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
 * Stores exact bytes by streaming. This performs no format interpretation at
 * all: material that no current reader understands is still preserved
 * faithfully, so a later, better reader can re-derive from the untouched
 * original instead of requiring the user to import again.
 */
export async function importArtifactFile(directory: string, filename: string) {
  const project = await loadProject(directory);
  const staged = await stageIntoTemporary(project.temporary, resolve(filename));
  let created: boolean;
  try {
    created = await publishArtifact(
      staged,
      artifactPath(project.artifacts, staged.id),
    );
  } catch (error) {
    throw await cleanupAfterFailure(error, staged.temporaryPath);
  }
  await removeTemporaryFile(staged.temporaryPath);
  return { id: staged.id, byteLength: staged.byteLength, created };
}

/**
 * Streams a stored artifact through SHA-256 and checks it against the name it
 * is stored under. Memory use is bounded by the chunk size, not the artifact.
 */
async function verifyStoredArtifact(
  artifactsDirectory: string,
  value: unknown,
) {
  const id = parseArtifactId(value);
  const actual = await hashFile(artifactPath(artifactsDirectory, id));
  if (actual.id !== id) {
    throw new ValidationError(
      'Stored artifact hash does not match its identity',
    );
  }
  return { id, byteLength: actual.byteLength };
}

function storedArtifactId(filename: string): ArtifactId {
  if (!/^[a-f0-9]{64}\.raw$/.test(filename)) {
    throw new ValidationError('Unexpected entry in the artifact store');
  }
  return parseArtifactId(`sha256:${filename.slice(0, -4)}`);
}

/**
 * Generic integrity check. Verifies every stored artifact against its own
 * identity without interpreting any of them, and without loading any of them
 * into memory.
 */
export async function inspectProject(directory: string) {
  const project = await loadProject(directory);
  const filenames = (await readdir(project.artifacts)).sort();
  const artifacts = [];
  for (const filename of filenames) {
    artifacts.push(
      await verifyStoredArtifact(project.artifacts, storedArtifactId(filename)),
    );
  }
  return { format: PROJECT_FORMAT, version: PROJECT_VERSION, artifacts };
}

export async function inspectArtifact(directory: string, value: unknown) {
  const project = await loadProject(directory);
  return verifyStoredArtifact(project.artifacts, value);
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
  const id = parseArtifactId(value);
  const path = artifactPath(project.artifacts, id);
  // Refuse on size from metadata alone. Storage has no ceiling, so a stored
  // artifact can be far larger than this format accepts, and it must be
  // refused without being read into memory.
  const { size } = await lstat(path);
  if (size > MAX_CONVERSATION_BYTES) {
    throw new ValidationError(
      `Artifact is ${size} bytes; this format accepts at most ${MAX_CONVERSATION_BYTES}`,
    );
  }
  const artifact = new Artifact(
    await readBounded(path, MAX_CONVERSATION_BYTES),
  );
  if (artifact.id !== id) {
    throw new ValidationError(
      'Stored artifact hash does not match its identity',
    );
  }
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
