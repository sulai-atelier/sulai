/**
 * Resolving the references on a state page against one occurrence: splitting
 * pages into lines, finding a line range's exact bytes by streaming, and reading
 * a range back with bounded memory.
 */
import { createHash } from 'node:crypto';
import {
  hasValidLines,
  parseArtifactId,
  parseLocator,
  ValidationError,
} from '@sulai/core';
import type {
  ArtifactId,
  Occurrence,
  StateReference,
  UnresolvedReason,
} from '@sulai/core';
import type { Project } from './project.js';
import {
  STREAM_CHUNK_BYTES,
  artifactPath,
  assertUnchangedSize,
  openRegularFile,
  readChunks,
} from './store.js';

/**
 * Splits a page into lines: a line ends at LF, a CR just before that LF is part
 * of the terminator, and a trailing LF does not start a new line.
 */
export function pageLines(page: string): string[] {
  if (page === '') return [];
  const lines = page.split('\n').map((line) => line.replace(/\r$/, ''));
  if (page.endsWith('\n')) lines.pop();
  return lines;
}

interface LineTable {
  readonly id: ArtifactId;
  readonly lines: number;
  readonly starts: ReadonlyMap<number, number>;
  readonly ends: ReadonlyMap<number, number>;
}

/**
 * One streaming pass over a stored artifact: its identity, its number of lines,
 * and where the requested lines start and where their content ends, excluding
 * the terminator. Memory is bounded by the chunk size.
 */
async function scanLines(
  path: string,
  wanted: ReadonlySet<number>,
): Promise<LineTable> {
  const handle = await openRegularFile(path);
  try {
    const expected = (await handle.stat()).size;
    const hash = createHash('sha256');
    const starts = new Map<number, number>();
    const ends = new Map<number, number>();
    let line = 1;
    let lineStart = 0;
    let offset = 0;
    let previous = -1;
    if (wanted.has(1)) starts.set(1, 0);
    for await (const chunk of readChunks(handle, expected)) {
      hash.update(chunk);
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index] as number;
        const at = offset + index;
        if (byte === 0x0a) {
          if (wanted.has(line)) {
            ends.set(line, at > lineStart && previous === 0x0d ? at - 1 : at);
          }
          line += 1;
          lineStart = at + 1;
          if (wanted.has(line)) starts.set(line, lineStart);
        }
        previous = byte;
      }
      offset += chunk.length;
    }
    assertUnchangedSize(offset, expected);
    let lines = line - 1;
    if (lineStart < offset) {
      // A last line without a terminator. A lone CR at the end is content.
      if (wanted.has(line)) ends.set(line, offset);
      lines = line;
    }
    return {
      id: parseArtifactId(`sha256:${hash.digest('hex')}`),
      lines,
      starts,
      ends,
    };
  } finally {
    await handle.close();
  }
}

/** Reads one byte range with bounded memory, validating it as UTF-8. */
export async function readRange(
  path: string,
  start: number,
  end: number,
  limit: number,
): Promise<{ text: string; valid: boolean; truncated: boolean }> {
  const handle = await openRegularFile(path);
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const buffer = Buffer.alloc(
      Math.min(STREAM_CHUNK_BYTES, Math.max(end - start, 1)),
    );
    let position = start;
    let kept = '';
    let keptBytes = 0;
    try {
      while (position < end) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, end - position),
          position,
        );
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        const decoded = decoder.decode(chunk, { stream: true });
        if (keptBytes < limit) {
          kept += decoded;
          keptBytes += bytesRead;
        }
        position += bytesRead;
      }
      kept += decoder.decode();
    } catch {
      return { text: '', valid: false, truncated: false };
    }
    const truncated = end - start > limit;
    if (truncated) {
      // Cut back to a character boundary so no character is split.
      const bytes = Buffer.from(kept, 'utf8');
      let cut = limit;
      while (cut > 0 && ((bytes[cut] as number) & 0xc0) === 0x80) cut -= 1;
      kept = bytes.subarray(0, cut).toString('utf8');
    }
    return { text: kept, valid: true, truncated };
  } finally {
    await handle.close();
  }
}

/**
 * Resolves each locator against one occurrence, never against anything else.
 * A locator that cannot be resolved stays unresolved with its reason; nothing
 * is retargeted.
 */
export async function resolveReferences(
  project: Project,
  occurrence: Occurrence,
  locators: readonly string[],
): Promise<StateReference[]> {
  const results = new Map<string, StateReference>();
  const pending = new Map<
    ArtifactId,
    { locator: string; startLine: number; endLine: number }[]
  >();
  const rootById = new Map(occurrence.roots.map((root) => [root.id, root]));
  for (const locator of locators) {
    const parsed = parseLocator(locator);
    if (parsed === null) continue;
    const unresolved = (reason: UnresolvedReason) =>
      results.set(locator, { locator, status: 'unresolved', reason });
    if (!hasValidLines(parsed)) {
      unresolved('invalid-lines');
      continue;
    }
    const root = rootById.get(parsed.root);
    if (root === undefined) {
      unresolved('unknown-root');
      continue;
    }
    if ((root.kind === 'file') !== (parsed.path === '')) {
      unresolved('path-not-in-occurrence');
      continue;
    }
    const entry = occurrence.entries.find(
      (item) => item.root === root.id && item.path === parsed.path,
    );
    if (entry === undefined) {
      const notCaptured =
        occurrence.skipped.some(
          (item) => item.root === root.id && item.path === parsed.path,
        ) ||
        occurrence.excluded.some(
          (item) =>
            item.root === root.id &&
            (parsed.path === item.path ||
              parsed.path.startsWith(`${item.path}/`)),
        );
      unresolved(notCaptured ? 'not-captured' : 'path-not-in-occurrence');
      continue;
    }
    const list = pending.get(entry.artifact) ?? [];
    list.push({
      locator,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
    });
    pending.set(entry.artifact, list);
  }
  for (const [artifact, wanted] of pending) {
    const path = artifactPath(project.artifacts, artifact);
    const table = await scanLines(
      path,
      new Set(wanted.flatMap((item) => [item.startLine, item.endLine])),
    );
    if (table.id !== artifact) {
      throw new ValidationError(
        'Stored artifact hash does not match its identity',
      );
    }
    for (const item of wanted) {
      if (item.endLine > table.lines) {
        results.set(item.locator, {
          locator: item.locator,
          status: 'unresolved',
          reason: 'line-out-of-range',
        });
        continue;
      }
      const startByte = table.starts.get(item.startLine) as number;
      const endByte = table.ends.get(item.endLine) as number;
      const { valid } = await readRange(path, startByte, endByte, 0);
      results.set(
        item.locator,
        valid
          ? {
              locator: item.locator,
              status: 'resolved',
              artifact,
              startByte,
              endByte,
            }
          : {
              locator: item.locator,
              status: 'unresolved',
              reason: 'not-utf8-text',
            },
      );
    }
  }
  return locators
    .filter((locator) => results.has(locator))
    .map((locator) => results.get(locator) as StateReference);
}

type Resolved = Extract<StateReference, { status: 'resolved' }>;

/**
 * Whether two resolved references cite the same bytes. The same artifact and
 * range are equal without reading; otherwise both ranges are compared by
 * streaming, so a moved or edited range is caught whatever the file's size.
 */
export async function sameEvidence(
  project: Project,
  a: Resolved,
  b: Resolved,
): Promise<boolean> {
  if (
    a.artifact === b.artifact &&
    a.startByte === b.startByte &&
    a.endByte === b.endByte
  ) {
    return true;
  }
  const length = a.endByte - a.startByte;
  if (length !== b.endByte - b.startByte) return false;
  const first = await openRegularFile(
    artifactPath(project.artifacts, a.artifact),
  );
  try {
    const second = await openRegularFile(
      artifactPath(project.artifacts, b.artifact),
    );
    try {
      const size = Math.min(STREAM_CHUNK_BYTES, Math.max(length, 1));
      const x = Buffer.alloc(size);
      const y = Buffer.alloc(size);
      for (let offset = 0; offset < length; offset += size) {
        const want = Math.min(size, length - offset);
        const [read1, read2] = await Promise.all([
          first.read(x, 0, want, a.startByte + offset),
          second.read(y, 0, want, b.startByte + offset),
        ]);
        if (
          read1.bytesRead !== want ||
          read2.bytesRead !== want ||
          !x.subarray(0, want).equals(y.subarray(0, want))
        ) {
          return false;
        }
      }
      return true;
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
}
