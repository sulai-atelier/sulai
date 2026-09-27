/**
 * EXPERIMENTAL. Reads the structure of one Claude Code local session transcript.
 *
 * Claude Code stores sessions as JSON Lines on the local disk. That layout is an
 * internal detail of another product, not a published interchange format, and it
 * can change without notice. This reader exists to learn from real local AI
 * history quickly. It is deliberately not part of the Sulai storage model:
 * nothing it produces is persisted, and @sulai/core does not depend on it.
 *
 * It reports structure only: record kinds, the uuid/parentUuid tree, and an
 * exact source unit for every record. It never returns message text, and it
 * never fails a whole transcript because of one line it cannot read, since an
 * undocumented format will produce lines no reader anticipated.
 */
import { createSourceUnit, ValidationError } from '@sulai/core';
import type { Artifact, SourceUnit } from '@sulai/core';

export const CLAUDE_CODE_SESSION_READER =
  'experimental.claude-code-local.session';

/**
 * A limit on this reader, not on storage. The reader holds the whole transcript
 * in memory to build its tree, so it bounds its input. Storage streams and has
 * no ceiling, so a larger transcript can be preserved and refused here.
 */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;

/** Record types observed to carry conversation turns. */
const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
]);

/** Record types observed to carry session state rather than turns. */
const METADATA_TYPES: ReadonlySet<string> = new Set([
  'mode',
  'permission-mode',
  'ai-title',
  'custom-title',
  'agent-name',
  'last-prompt',
  'file-history-snapshot',
  'file-history-delta',
  'queue-operation',
  'atis-latch',
  'cost-state',
]);

export type ClaudeCodeRecordKind =
  'message' | 'metadata' | 'unknown' | 'unparseable';

export interface ClaudeCodeRecord {
  /** One-based line number within the transcript. */
  readonly line: number;
  /** The exact record bytes, excluding its LF or CRLF delimiter. */
  readonly sourceUnit: SourceUnit;
  readonly kind: ClaudeCodeRecordKind;
  readonly type: string | null;
  readonly uuid: string | null;
  readonly parentUuid: string | null;
  readonly timestamp: string | null;
  readonly sessionId: string | null;
  readonly isSidechain: boolean | null;
  readonly agentId: string | null;
  readonly role: string | null;
  /** Block types in order, or ['string'] for plain string content. Never text. */
  readonly contentBlocks: readonly string[];
}

export interface ClaudeCodeSessionReading {
  readonly reader: typeof CLAUDE_CODE_SESSION_READER;
  readonly artifactId: Artifact['id'];
  readonly records: readonly ClaudeCodeRecord[];
  /** Records whose parentUuid is explicitly null. */
  readonly roots: readonly string[];
  /** uuids with more than one child record. */
  readonly branchPoints: readonly string[];
  /** parentUuid values that name no record in this transcript. */
  readonly unresolvedParents: readonly string[];
  /** uuids that appear on more than one record. */
  readonly duplicateUuids: readonly string[];
  /** Distinct `type` values this reader does not recognize. */
  readonly unknownTypes: readonly string[];
  /** Line numbers of empty lines, which have no source unit. */
  readonly blankLines: readonly number[];
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentBlocks(content: unknown): string[] {
  if (typeof content === 'string') return ['string'];
  if (!Array.isArray(content)) return [];
  return content.map((block: unknown) =>
    isObject(block) && typeof block.type === 'string'
      ? block.type
      : '<non-object>',
  );
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function unparseable(line: number, sourceUnit: SourceUnit): ClaudeCodeRecord {
  return {
    line,
    sourceUnit,
    kind: 'unparseable',
    type: null,
    uuid: null,
    parentUuid: null,
    timestamp: null,
    sessionId: null,
    isSidechain: null,
    agentId: null,
    role: null,
    contentBlocks: [],
  };
}

interface ParsedLine {
  readonly record: ClaudeCodeRecord;
  /** True only when parentUuid is present and null, not merely absent. */
  readonly explicitRoot: boolean;
}

function readRecord(
  artifact: Artifact,
  line: number,
  startByte: number,
  endByte: number,
): ParsedLine {
  const sourceUnit = createSourceUnit(artifact, startByte, endByte);
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(artifact.slice(startByte, endByte)));
  } catch {
    return { record: unparseable(line, sourceUnit), explicitRoot: false };
  }
  if (!isObject(value)) {
    return { record: unparseable(line, sourceUnit), explicitRoot: false };
  }
  const type = text(value.type);
  const kind: ClaudeCodeRecordKind =
    type !== null && MESSAGE_TYPES.has(type)
      ? 'message'
      : type !== null && METADATA_TYPES.has(type)
        ? 'metadata'
        : 'unknown';
  const message = isObject(value.message) ? value.message : null;
  const uuid = text(value.uuid);
  return {
    record: {
      line,
      sourceUnit,
      kind,
      type,
      uuid,
      parentUuid: text(value.parentUuid),
      timestamp: text(value.timestamp),
      sessionId: text(value.sessionId),
      isSidechain: flag(value.isSidechain),
      agentId: text(value.agentId),
      role: message ? text(message.role) : null,
      contentBlocks: message ? contentBlocks(message.content) : [],
    },
    explicitRoot:
      uuid !== null &&
      Object.hasOwn(value, 'parentUuid') &&
      value.parentUuid === null,
  };
}

/**
 * Reads the structure of one session transcript. Accepts LF and CRLF
 * delimiters and a final record with no delimiter, which is what an
 * interrupted write leaves behind.
 */
export function readClaudeCodeSession(
  artifact: Artifact,
): ClaudeCodeSessionReading {
  if (artifact.byteLength > MAX_SESSION_BYTES) {
    throw new ValidationError(
      `Transcript is ${artifact.byteLength} bytes; this reader accepts at most ${MAX_SESSION_BYTES}`,
    );
  }
  const bytes = artifact.bytes();
  const records: ClaudeCodeRecord[] = [];
  const blankLines: number[] = [];
  const explicitRoots: string[] = [];
  let line = 0;
  let start = 0;
  while (start < bytes.length) {
    line += 1;
    let newline = bytes.indexOf(0x0a, start);
    if (newline === -1) newline = bytes.length;
    let end = newline;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    if (end === start) {
      blankLines.push(line);
    } else {
      const parsed = readRecord(artifact, line, start, end);
      records.push(parsed.record);
      if (parsed.explicitRoot && parsed.record.uuid !== null) {
        explicitRoots.push(parsed.record.uuid);
      }
    }
    start = newline + 1;
  }

  const byUuid = new Map<string, number>();
  const children = new Map<string, number>();
  const unknownTypes = new Set<string>();
  for (const record of records) {
    if (record.kind === 'unknown' && record.type !== null) {
      unknownTypes.add(record.type);
    }
    if (record.uuid !== null) {
      byUuid.set(record.uuid, (byUuid.get(record.uuid) ?? 0) + 1);
    }
    if (record.parentUuid !== null) {
      children.set(
        record.parentUuid,
        (children.get(record.parentUuid) ?? 0) + 1,
      );
    }
  }
  return {
    reader: CLAUDE_CODE_SESSION_READER,
    artifactId: artifact.id,
    records,
    roots: explicitRoots,
    branchPoints: [...children]
      .filter(([, count]) => count > 1)
      .map(([uuid]) => uuid),
    unresolvedParents: [...children.keys()].filter((uuid) => !byUuid.has(uuid)),
    duplicateUuids: [...byUuid]
      .filter(([, count]) => count > 1)
      .map(([uuid]) => uuid),
    unknownTypes: [...unknownTypes],
    blankLines,
  };
}
