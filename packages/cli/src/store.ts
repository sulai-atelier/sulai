/**
 * Immutable, content-addressed storage: bounded streaming reads, staging into
 * temporary files, and publication by hard link that never replaces existing
 * bytes. Nothing here knows about projects, occurrences or state.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArtifactId, ValidationError } from '@sulai/core';
import type { ArtifactId, SkipReason } from '@sulai/core';

/**
 * The most memory any streaming read holds, whatever the size of the artifact.
 * Preservation and verification both stream, so there is no storage size
 * ceiling: the real constraint is disk space, and running out of it fails and
 * cleans up like any other write error.
 */
export const STREAM_CHUNK_BYTES = 1024 * 1024;

export const STORE_MODE = 0o700;

export async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ValidationError('Project storage must use regular directories');
  }
}

export async function openRegularFile(path: string): Promise<FileHandle> {
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
export function assertUnchangedSize(observed: number, expected: number): void {
  if (observed !== expected) {
    throw new ValidationError('File changed size while it was being read');
  }
}

/**
 * An input that could not be captured, as opposed to a failure of the store.
 * A directory acquisition records the first kind as a skipped input and keeps
 * going; the second kind stops the acquisition, because the store is at fault.
 */
export class InputUnavailable extends ValidationError {
  readonly reason: SkipReason;

  constructor(reason: SkipReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

/**
 * Yields bytes in bounded chunks from the current file position. The buffer is
 * reused, so a chunk is valid only until the next one is requested; every
 * consumer finishes with it before asking for more. It is sized from
 * the file's observed size, one byte larger so growth is still read, and never
 * beyond one chunk: a directory of small files then costs small buffers, not a
 * full chunk each.
 */
export async function* readChunks(
  handle: FileHandle,
  observedSize: number,
): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.alloc(Math.min(STREAM_CHUNK_BYTES, observedSize + 1));
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
    for await (const chunk of readChunks(handle, expected)) {
      hash.update(chunk);
      byteLength += chunk.byteLength;
    }
    assertUnchangedSize(byteLength, expected);
    return { id: parseArtifactId(`sha256:${hash.digest('hex')}`), byteLength };
  } finally {
    await handle.close();
  }
}

export async function readBounded(
  path: string,
  limit: number,
): Promise<Buffer> {
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

export function hasCode(error: unknown, ...codes: readonly string[]): boolean {
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

export async function removeTemporaryFile(path: string): Promise<void> {
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
 * Renames a file over another, retrying while Windows reports either one
 * locked. A scanner or indexer can hold a file just written, or the one it
 * replaces, for many seconds, so the wait is long: up to a minute, as npm
 * allows its own renames. Any other failure is thrown at once.
 */
export async function renameReplacing(
  from: string,
  to: string,
  budgetMs = 60_000,
): Promise<void> {
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (
        !hasCode(error, ...TRANSIENT_UNLINK_CODES) ||
        Date.now() - started >= budgetMs
      ) {
        throw error;
      }
      await delay(Math.min(1000, 50 * 2 ** attempt));
    }
  }
}

/**
 * Removes a temporary file after a failure and returns the error to throw. If
 * cleanup also fails, both causes are kept rather than the first being lost.
 */
export async function cleanupAfterFailure(
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
 * Publishes a small byte sequence, already in memory, under a fixed name,
 * refusing to replace different existing content. Used for the project marker,
 * occurrence records, state revisions and state pages.
 */
export async function writeImmutable(
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

/** Bytes written to a synced temporary file, not yet published. */
export interface Staged {
  readonly temporaryPath: string;
  readonly id: ArtifactId;
  readonly byteLength: number;
}

export interface StagedArtifact extends Staged {
  readonly modifiedAt: string;
}

/**
 * Streams chunks into a new temporary file, hashing as it goes, so the identity
 * is known once the last byte is written and no more than one chunk is ever in
 * memory. The file is synced before this returns, and removed if anything
 * fails, whether writing or reading the chunks.
 */
export async function stageChunks(
  temporaryDirectory: string,
  chunks: AsyncIterable<Uint8Array>,
): Promise<Staged> {
  await prepareTemporaryDirectory(temporaryDirectory);
  const temporaryPath = join(temporaryDirectory, randomUUID());
  try {
    const hash = createHash('sha256');
    let byteLength = 0;
    const target = await open(temporaryPath, 'wx', 0o600);
    try {
      for await (const chunk of chunks) {
        hash.update(chunk);
        await writeAll(target, chunk);
        byteLength += chunk.byteLength;
      }
      await target.sync();
    } finally {
      await target.close();
    }
    return {
      temporaryPath,
      id: parseArtifactId(`sha256:${hash.digest('hex')}`),
      byteLength,
    };
  } catch (error) {
    throw await cleanupAfterFailure(error, temporaryPath);
  }
}

/**
 * Yields an input's chunks, reporting a failed read as the input being
 * unavailable rather than as a store failure.
 */
async function* inputChunks(
  handle: FileHandle,
  observedSize: number,
): AsyncGenerator<Uint8Array> {
  const chunks = readChunks(handle, observedSize);
  for (;;) {
    let next: IteratorResult<Uint8Array>;
    try {
      next = await chunks.next();
    } catch (error) {
      throw new InputUnavailable('unreadable', 'Input could not be read', {
        cause: error,
      });
    }
    if (next.done === true) return;
    yield next.value;
  }
}

/**
 * Stages an open input by streaming (see `stageChunks`). Failures of the input
 * are `InputUnavailable`; anything else is a failure of the store.
 */
export async function stageFromHandle(
  temporaryDirectory: string,
  source: FileHandle,
): Promise<StagedArtifact> {
  let observed;
  try {
    observed = await source.stat();
  } catch (error) {
    throw new InputUnavailable('unreadable', 'Input could not be read', {
      cause: error,
    });
  }
  const staged = await stageChunks(
    temporaryDirectory,
    inputChunks(source, observed.size),
  );
  if (staged.byteLength !== observed.size) {
    throw await cleanupAfterFailure(
      new InputUnavailable(
        'changed-during-read',
        'File changed size while it was being read',
      ),
      staged.temporaryPath,
    );
  }
  return { ...staged, modifiedAt: observed.mtime.toISOString() };
}

export async function stageIntoTemporary(
  temporaryDirectory: string,
  sourcePath: string,
): Promise<StagedArtifact> {
  const source = await openRegularFile(sourcePath);
  try {
    return await stageFromHandle(temporaryDirectory, source);
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
export async function publishArtifact(
  staged: Staged,
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

export function artifactPath(
  artifactsDirectory: string,
  id: ArtifactId,
): string {
  return join(artifactsDirectory, `${id.slice('sha256:'.length)}.raw`);
}

/**
 * Streams a stored artifact through SHA-256 and checks it against the name it
 * is stored under. Memory use is bounded by the chunk size, not the artifact.
 */
export async function verifyStoredArtifact(
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

export function storedArtifactId(filename: string): ArtifactId {
  if (!/^[a-f0-9]{64}\.raw$/.test(filename)) {
    throw new ValidationError('Unexpected entry in the artifact store');
  }
  return parseArtifactId(`sha256:${filename.slice(0, -4)}`);
}
