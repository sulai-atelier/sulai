/**
 * Interpretation: reading a stored artifact through one specific format.
 */
import { MAX_CONVERSATION_BYTES, importConversation } from '@sulai/core';
import type { Artifact, ImportedConversation } from '@sulai/core';
import { readStoredArtifact } from './artifacts.js';

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
