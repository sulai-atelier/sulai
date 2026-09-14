import { Artifact } from './artifact.js';
import { createSourceUnit } from './source.js';
import type { SourceUnit } from './source.js';
import { record, ValidationError } from './validation.js';

export const CONVERSATION_FORMAT = 'sulai.conversation.v1';
export const MAX_CONVERSATION_BYTES = 1024 * 1024;
export const MAX_CONVERSATION_MESSAGES = 10_000;

export interface ConversationMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
  readonly sourceUnit: SourceUnit;
}

export interface ImportedConversation {
  readonly format: typeof CONVERSATION_FORMAT;
  readonly artifact: Artifact;
  readonly messages: readonly ConversationMessage[];
}

function parseLine(bytes: Uint8Array, lineNumber: number): unknown {
  try {
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    const keys = new Set<string>();
    // The format is flat. Scan complete string tokens so escaped key names count once.
    for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
      if (!/^\s*:/u.test(text.slice(match.index + match[0].length))) continue;
      const key = JSON.parse(match[0]) as string;
      if (keys.has(key)) throw new ValidationError('Duplicate field');
      keys.add(key);
    }
    return value;
  } catch {
    throw new ValidationError(
      `Line ${lineNumber} must contain unambiguous UTF-8 JSON`,
    );
  }
}

export function importConversation(bytes: Uint8Array): ImportedConversation {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new ValidationError('Conversation must contain nonempty bytes');
  }
  if (bytes.byteLength > MAX_CONVERSATION_BYTES) {
    throw new ValidationError(
      `Conversation exceeds ${MAX_CONVERSATION_BYTES} bytes`,
    );
  }
  const artifact = new Artifact(bytes);
  const raw = artifact.bytes();
  const messages: ConversationMessage[] = [];
  let startByte = 0;
  let lineNumber = 0;

  for (let cursor = 0; cursor <= raw.length; cursor += 1) {
    if (cursor !== raw.length && raw[cursor] !== 0x0a) continue;
    if (cursor === raw.length && startByte === cursor) break;

    lineNumber += 1;
    // CR belongs to a CRLF delimiter only when followed by an actual LF.
    const endByte =
      cursor < raw.length && raw[cursor - 1] === 0x0d ? cursor - 1 : cursor;
    const input = parseLine(raw.subarray(startByte, endByte), lineNumber);

    if (lineNumber === 1) {
      const header = record(input, ['format'], 'Conversation header');
      if (header.format !== CONVERSATION_FORMAT) {
        throw new ValidationError('Unsupported conversation format');
      }
    } else {
      if (messages.length >= MAX_CONVERSATION_MESSAGES) {
        throw new ValidationError(
          `Conversation exceeds ${MAX_CONVERSATION_MESSAGES} messages`,
        );
      }
      const message = record(
        input,
        ['role', 'content'],
        `Message on line ${lineNumber}`,
      );
      if (
        message.role !== 'system' &&
        message.role !== 'user' &&
        message.role !== 'assistant'
      ) {
        throw new ValidationError(`Invalid role on line ${lineNumber}`);
      }
      if (
        typeof message.content !== 'string' ||
        !message.content.isWellFormed()
      ) {
        throw new ValidationError(
          `Content on line ${lineNumber} must be a Unicode string`,
        );
      }
      messages.push(
        Object.freeze({
          role: message.role,
          content: message.content,
          sourceUnit: createSourceUnit(artifact, startByte, endByte),
        }),
      );
    }
    startByte = cursor + 1;
  }

  if (messages.length === 0) {
    throw new ValidationError('Conversation must contain at least one message');
  }
  return Object.freeze({
    format: CONVERSATION_FORMAT,
    artifact,
    messages: Object.freeze(messages),
  });
}
