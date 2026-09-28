/**
 * Experimental commands. Kept out of project.ts so that the storage module never
 * imports an experimental reader: storage preserves bytes, and what reads them
 * here can change or disappear without touching it.
 */
import {
  MAX_SESSION_BYTES,
  readClaudeCodeSession,
} from '@sulai/experimental-claude-code';
import { readStoredArtifact } from './project.js';

/**
 * Reads the structure of a stored Claude Code session transcript. Returns
 * record kinds, the uuid tree and exact source units. Never returns message
 * text. The output still carries transcript metadata, such as record ids and
 * types, so treat it as sensitive.
 */
export async function readClaudeCodeSessionArtifact(
  directory: string,
  value: unknown,
) {
  const artifact = await readStoredArtifact(
    directory,
    value,
    MAX_SESSION_BYTES,
  );
  const reading = readClaudeCodeSession(artifact);
  const kinds: Record<string, number> = {};
  const types: Record<string, number> = {};
  for (const record of reading.records) {
    kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
    const type = record.type ?? '<none>';
    types[type] = (types[type] ?? 0) + 1;
  }
  return {
    reader: reading.reader,
    artifactId: reading.artifactId,
    byteLength: artifact.byteLength,
    recordCount: reading.records.length,
    kinds,
    types,
    roots: reading.roots,
    branchPoints: reading.branchPoints,
    unresolvedParents: reading.unresolvedParents,
    duplicateUuids: reading.duplicateUuids,
    unknownTypes: reading.unknownTypes,
    blankLines: reading.blankLines,
    records: reading.records,
  };
}
