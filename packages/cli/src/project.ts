import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Artifact,
  MAX_CONVERSATION_BYTES,
  MAX_OCCURRENCE_BYTES,
  encodeOccurrence,
  importConversation,
  occurrenceIdOf,
  parseArtifactId,
  parseOccurrence,
  parseOccurrenceId,
  ValidationError,
} from '@sulai/core';
import type {
  ArtifactId,
  ImportedConversation,
  Occurrence,
  OccurrenceEntry,
  OccurrenceExclusion,
  OccurrenceId,
  OccurrenceSkip,
  SkipReason,
} from '@sulai/core';

const PROJECT_FORMAT = 'sulai.project';
const PROJECT_VERSION = 3;

/**
 * The project marker describes the Sulai storage format only. It deliberately
 * says nothing about the format of the artifacts inside, because an artifact is
 * exact bytes of any kind. Version 1 embedded `artifactFormat`; version 2 had no
 * occurrence records. Both are refused rather than half-verified.
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
    occurrences: join(store, 'occurrences'),
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
 * An input that could not be captured, as opposed to a failure of the store.
 * A directory acquisition records the first kind as a skipped input and keeps
 * going; the second kind stops the acquisition, because the store is at fault.
 */
class InputUnavailable extends ValidationError {
  readonly reason: SkipReason;

  constructor(reason: SkipReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

/**
 * Yields bytes in bounded chunks from the current file position. The buffer is
 * reused, so a chunk is valid only until the next one is requested; every
 * consumer here hashes and writes it before asking for more. It is sized from
 * the file's observed size, one byte larger so growth is still read, and never
 * beyond one chunk: a directory of small files then costs small buffers, not a
 * full chunk each.
 */
async function* readChunks(
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
  readonly modifiedAt: string;
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
 * Streams an open input into a new temporary file, hashing as it goes, so the
 * identity is known once the last byte is written and no more than one chunk is
 * ever in memory. The temporary file is synced before this returns. Failures of
 * the input are `InputUnavailable`; anything else is a failure of the store.
 */
async function stageFromHandle(
  temporaryDirectory: string,
  source: FileHandle,
): Promise<StagedArtifact> {
  await prepareTemporaryDirectory(temporaryDirectory);
  const temporaryPath = join(temporaryDirectory, randomUUID());
  try {
    let observed;
    try {
      observed = await source.stat();
    } catch (error) {
      throw new InputUnavailable('unreadable', 'Input could not be read', {
        cause: error,
      });
    }
    const hash = createHash('sha256');
    let byteLength = 0;
    const target = await open(temporaryPath, 'wx', 0o600);
    try {
      for await (const chunk of inputChunks(source, observed.size)) {
        hash.update(chunk);
        await writeAll(target, chunk);
        byteLength += chunk.byteLength;
      }
      await target.sync();
    } finally {
      await target.close();
    }
    if (byteLength !== observed.size) {
      throw new InputUnavailable(
        'changed-during-read',
        'File changed size while it was being read',
      );
    }
    return {
      temporaryPath,
      id: parseArtifactId(`sha256:${hash.digest('hex')}`),
      byteLength,
      modifiedAt: observed.mtime.toISOString(),
    };
  } catch (error) {
    throw await cleanupAfterFailure(error, temporaryPath);
  }
}

async function stageIntoTemporary(
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
  // Check the marker before the directories, so a project in an older format
  // is refused by name rather than for a directory it never had.
  const bytes = await readBounded(project.marker, 4096);
  if (!bytes.equals(PROJECT_FILE)) {
    throw new ValidationError(describeUnsupportedMarker(bytes));
  }
  await assertDirectory(project.artifacts);
  await assertDirectory(project.occurrences);
  // `.sulai/tmp` is ephemeral and is recreated on demand, so its absence does
  // not make a project invalid.
  return project;
}

export async function initializeProject(directory: string) {
  const project = paths(directory);
  await mkdir(project.root, { recursive: true });
  // Validate an existing marker before creating or publishing anything, so an
  // incompatible project is refused by version and left exactly as it was.
  try {
    const existing = await readBounded(project.marker, 4096);
    if (!existing.equals(PROJECT_FILE)) {
      throw new ValidationError(describeUnsupportedMarker(existing));
    }
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  for (const path of [
    project.store,
    project.artifacts,
    project.occurrences,
    project.temporary,
  ]) {
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

function occurrencePath(occurrencesDirectory: string, id: OccurrenceId) {
  return join(
    occurrencesDirectory,
    `${id.slice('occurrence:v1:'.length)}.json`,
  );
}

/** Why an input that was listed could not be opened, or null for a real fault. */
function openFailure(error: unknown): SkipReason | null {
  if (hasCode(error, 'ENOENT')) return 'vanished';
  if (hasCode(error, 'EACCES', 'EPERM', 'EBUSY')) return 'unreadable';
  // It was a regular file when listed; a link or anything else now means it
  // changed between being listed and being opened.
  if (hasCode(error, 'ELOOP', 'ENOTDIR') || error instanceof ValidationError) {
    return 'changed-during-read';
  }
  return null;
}

function listFailure(error: unknown): SkipReason | null {
  if (hasCode(error, 'ENOENT')) return 'vanished';
  if (hasCode(error, 'EACCES', 'EPERM')) return 'unreadable';
  if (hasCode(error, 'ENOTDIR')) return 'changed-during-read';
  return null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function byUtf8Path(a: { path: string }, b: { path: string }): number {
  return Buffer.compare(
    Buffer.from(a.path, 'utf8'),
    Buffer.from(b.path, 'utf8'),
  );
}

/**
 * Preserves a file, or every file under a directory, and records the attempt
 * as one import occurrence.
 *
 * Only the named root is read. Symbolic links and junctions are never followed,
 * and no content is read for references to anything else, so an acquisition
 * never reaches outside what the caller chose. The project's own store is
 * excluded when it lies inside the root. An input that cannot be captured is
 * recorded as skipped with a reason and the rest continues; a failure of the
 * store stops the acquisition. Every artifact is published before the
 * occurrence, so an occurrence never names bytes the store does not hold.
 *
 * The walk is not atomic. Inputs that appear during it may be missed, and a
 * complete occurrence means that everything the walk found was captured, not
 * that the result is a snapshot of one instant.
 */
export async function importPath(directory: string, input: string) {
  const project = await loadProject(directory);
  const locator = resolve(input);
  const insideStore = relative(project.store, locator);
  if (
    insideStore === '' ||
    (!insideStore.startsWith('..') && !isAbsolute(insideStore))
  ) {
    throw new ValidationError('Cannot acquire from inside the project store');
  }
  const rootStat = await lstat(locator);
  if (rootStat.isSymbolicLink()) {
    throw new ValidationError('The input must not be a symbolic link');
  }
  if (!rootStat.isFile() && !rootStat.isDirectory()) {
    throw new ValidationError(
      'The input must be a regular file or a directory',
    );
  }
  const kind = rootStat.isFile() ? 'file' : 'directory';
  const store = await lstat(project.store, { bigint: true });
  const isStore = (stat: { dev: bigint; ino: bigint }, path: string) =>
    (stat.ino !== 0n && stat.dev === store.dev && stat.ino === store.ino) ||
    relative(project.store, path) === '';

  const root = 'r1';
  const startedAt = new Date().toISOString();
  const nonce = randomBytes(16).toString('hex');
  const entries: OccurrenceEntry[] = [];
  const skipped: OccurrenceSkip[] = [];
  const excluded: OccurrenceExclusion[] = [];
  const isNew = new Map<ArtifactId, boolean>();
  const skip = (path: string, reason: SkipReason) =>
    skipped.push({ root, path, reason });

  async function capture(absolute: string, path: string): Promise<void> {
    let source: FileHandle;
    try {
      source = await openRegularFile(absolute);
    } catch (error) {
      const reason = openFailure(error);
      if (reason === null) throw error;
      skip(path, reason);
      return;
    }
    let staged: StagedArtifact;
    try {
      staged = await stageFromHandle(project.temporary, source);
    } catch (error) {
      if (!(error instanceof InputUnavailable)) throw error;
      skip(path, error.reason);
      return;
    } finally {
      await source.close();
    }
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
    // The first capture of these bytes in this acquisition decides whether the
    // acquisition added them; a later duplicate did not find them already there.
    const added = isNew.get(staged.id) ?? created;
    isNew.set(staged.id, added);
    entries.push({
      root,
      path,
      artifact: staged.id,
      byteLength: staged.byteLength,
      modifiedAt: staged.modifiedAt,
      new: added,
    });
  }

  async function walk(absolute: string, path: string): Promise<void> {
    let names: Buffer[];
    try {
      names = await readdir(absolute, { encoding: 'buffer' });
    } catch (error) {
      const reason = listFailure(error);
      if (reason === null || path === '') throw error;
      skip(path, reason);
      return;
    }
    names.sort(Buffer.compare);
    for (const raw of names) {
      let name: string;
      try {
        name = utf8.decode(raw);
      } catch {
        const lossy = raw.toString('utf8');
        skip(path === '' ? lossy : `${path}/${lossy}`, 'non-utf8-name');
        continue;
      }
      const child = join(absolute, name);
      const childPath = path === '' ? name : `${path}/${name}`;
      let stat;
      try {
        stat = await lstat(child, { bigint: true });
      } catch (error) {
        const reason = listFailure(error);
        if (reason === null) throw error;
        skip(childPath, reason);
        continue;
      }
      if (stat.isSymbolicLink()) {
        skip(childPath, 'symbolic-link');
      } else if (stat.isDirectory()) {
        if (isStore(stat, child)) {
          excluded.push({ root, path: childPath, reason: 'project-store' });
        } else {
          await walk(child, childPath);
        }
      } else if (stat.isFile()) {
        await capture(child, childPath);
      } else {
        skip(childPath, 'not-regular-file');
      }
    }
  }

  if (kind === 'file') await capture(locator, '');
  else await walk(locator, '');

  entries.sort(byUtf8Path);
  skipped.sort(byUtf8Path);
  excluded.sort(byUtf8Path);
  const { id, bytes, occurrence } = encodeOccurrence({
    format: 'sulai.occurrence',
    version: 1,
    nonce,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: skipped.length === 0 ? 'complete' : 'partial',
    roots: [{ id: root, kind, platform: process.platform, locator }],
    entries,
    skipped,
    excluded,
  });
  // Published last, and never replacing anything: until this link exists the
  // acquisition has no record, and the artifacts it stored are only unreferenced.
  await writeImmutable(
    project.temporary,
    occurrencePath(project.occurrences, id),
    bytes,
  );
  const distinct = [...isNew.values()];
  return {
    occurrenceId: id,
    status: occurrence.status,
    root: { kind, locator },
    entryCount: occurrence.entries.length,
    newArtifacts: distinct.filter(Boolean).length,
    existingArtifacts: distinct.filter((added) => !added).length,
    skipped: occurrence.skipped.map(({ path, reason }) => ({ path, reason })),
    excluded: occurrence.excluded.map(({ path, reason }) => ({ path, reason })),
  };
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

function storedOccurrenceId(filename: string): OccurrenceId {
  if (!/^[a-f0-9]{64}\.json$/.test(filename)) {
    throw new ValidationError('Unexpected entry in the occurrence store');
  }
  return parseOccurrenceId(`occurrence:v1:${filename.slice(0, -5)}`);
}

/**
 * Reads one stored occurrence, checks it still hashes to the name it is stored
 * under, and parses it strictly. Nothing about the inputs it names is trusted
 * until the artifacts are checked separately.
 */
async function readStoredOccurrence(
  occurrencesDirectory: string,
  id: OccurrenceId,
): Promise<Occurrence> {
  const bytes = await readBounded(
    occurrencePath(occurrencesDirectory, id),
    MAX_OCCURRENCE_BYTES,
  );
  if (occurrenceIdOf(bytes) !== id) {
    throw new ValidationError(
      'Stored occurrence hash does not match its identity',
    );
  }
  return parseOccurrence(bytes);
}

function assertStoredArtifacts(
  occurrence: Occurrence,
  stored: ReadonlyMap<ArtifactId, number>,
): void {
  for (const entry of occurrence.entries) {
    const byteLength = stored.get(entry.artifact);
    if (byteLength === undefined) {
      throw new ValidationError(
        'Occurrence names an artifact that is not stored',
      );
    }
    if (byteLength !== entry.byteLength) {
      throw new ValidationError(
        'Occurrence disagrees with the stored artifact size',
      );
    }
  }
}

function summarize(id: OccurrenceId, occurrence: Occurrence) {
  return {
    id,
    status: occurrence.status,
    startedAt: occurrence.startedAt,
    entries: occurrence.entries.length,
    skipped: occurrence.skipped.length,
    excluded: occurrence.excluded.length,
  };
}

/**
 * Generic integrity check. Verifies every stored artifact against its own
 * identity without interpreting any of them, and without loading any of them
 * into memory. Then verifies every occurrence record the same way, parses it
 * strictly, and checks that every artifact it names is stored at the size it
 * records.
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
  const stored = new Map(
    artifacts.map((artifact) => [artifact.id, artifact.byteLength]),
  );
  const occurrences = [];
  for (const filename of (await readdir(project.occurrences)).sort()) {
    const id = storedOccurrenceId(filename);
    const occurrence = await readStoredOccurrence(project.occurrences, id);
    assertStoredArtifacts(occurrence, stored);
    occurrences.push(summarize(id, occurrence));
  }
  occurrences.sort((a, b) =>
    a.startedAt === b.startedAt
      ? a.id.localeCompare(b.id)
      : a.startedAt.localeCompare(b.startedAt),
  );
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    artifacts,
    occurrences,
  };
}

export async function inspectArtifact(directory: string, value: unknown) {
  const project = await loadProject(directory);
  return verifyStoredArtifact(project.artifacts, value);
}

/**
 * One occurrence in full, after verifying the record and, by streaming hash,
 * every artifact it names.
 */
export async function inspectOccurrence(directory: string, value: unknown) {
  const project = await loadProject(directory);
  const id = parseOccurrenceId(value);
  const occurrence = await readStoredOccurrence(project.occurrences, id);
  const stored = new Map<ArtifactId, number>();
  for (const entry of occurrence.entries) {
    if (!stored.has(entry.artifact)) {
      try {
        const verified = await verifyStoredArtifact(
          project.artifacts,
          entry.artifact,
        );
        stored.set(verified.id, verified.byteLength);
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
      }
    }
  }
  assertStoredArtifacts(occurrence, stored);
  return { id, ...occurrence };
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
 * Loads one stored artifact into memory for a reader that needs all of it,
 * after refusing it from filesystem metadata alone if it exceeds that reader's
 * limit, and after verifying it still has the identity it is stored under.
 * Storage has no ceiling, so any reader that buffers must bound itself here.
 */
export async function readStoredArtifact(
  directory: string,
  value: unknown,
  limit: number,
): Promise<Artifact> {
  const project = await loadProject(directory);
  const id = parseArtifactId(value);
  const path = artifactPath(project.artifacts, id);
  const { size } = await lstat(path);
  if (size > limit) {
    throw new ValidationError(
      `Artifact is ${size} bytes; this format accepts at most ${limit}`,
    );
  }
  const artifact = new Artifact(await readBounded(path, limit));
  if (artifact.id !== id) {
    throw new ValidationError(
      'Stored artifact hash does not match its identity',
    );
  }
  return artifact;
}

/**
 * An interpretation, deliberately separate from storage. Preservation happened
 * at import; this reads stored bytes through one specific format and can be
 * changed or replaced without touching what was preserved.
 */
export async function interpretConversation(directory: string, value: unknown) {
  const artifact = await readStoredArtifact(
    directory,
    value,
    MAX_CONVERSATION_BYTES,
  );
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
