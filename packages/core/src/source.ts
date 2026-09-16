import { createHash } from 'node:crypto';
import type { Artifact, ArtifactId } from './artifact.js';
import { byteRange, record, ValidationError } from './validation.js';

export interface SourceUnit {
  readonly id: `source-unit:v1:${string}`;
  readonly artifactId: ArtifactId;
  readonly startByte: number;
  readonly endByte: number;
}

export interface SourceSpan {
  readonly id: `source-span:v1:${string}`;
  readonly sourceUnitId: SourceUnit['id'];
  readonly startByte: number;
  readonly endByte: number;
}

function digest(parts: readonly (string | number)[]): string {
  return createHash('sha256')
    .update(JSON.stringify(parts), 'utf8')
    .digest('hex');
}

export function createSourceUnit(
  artifact: Artifact,
  startByte: number,
  endByte: number,
): SourceUnit {
  byteRange(startByte, endByte, 0, artifact.byteLength);
  return Object.freeze({
    id: `source-unit:v1:${digest(['source-unit', 1, artifact.id, startByte, endByte])}`,
    artifactId: artifact.id,
    startByte,
    endByte,
  });
}

export function parseSourceUnit(
  value: unknown,
  artifact: Artifact,
): SourceUnit {
  const input = record(
    value,
    ['id', 'artifactId', 'startByte', 'endByte'],
    'Source unit',
  );
  const range = byteRange(
    input.startByte,
    input.endByte,
    0,
    artifact.byteLength,
  );
  const unit = createSourceUnit(artifact, range.startByte, range.endByte);
  if (input.artifactId !== unit.artifactId || input.id !== unit.id) {
    throw new ValidationError(
      'Source unit identity does not match the artifact and range',
    );
  }
  return unit;
}

export function createSourceSpan(
  artifact: Artifact,
  sourceUnit: SourceUnit,
  startByte: number,
  endByte: number,
): SourceSpan {
  const unit = parseSourceUnit(sourceUnit, artifact);
  byteRange(startByte, endByte, unit.startByte, unit.endByte);
  return Object.freeze({
    id: `source-span:v1:${digest(['source-span', 1, unit.id, startByte, endByte])}`,
    sourceUnitId: unit.id,
    startByte,
    endByte,
  });
}

export function parseSourceSpan(
  value: unknown,
  artifact: Artifact,
  sourceUnit: SourceUnit,
): SourceSpan {
  const unit = parseSourceUnit(sourceUnit, artifact);
  const input = record(
    value,
    ['id', 'sourceUnitId', 'startByte', 'endByte'],
    'Source span',
  );
  const range = byteRange(
    input.startByte,
    input.endByte,
    unit.startByte,
    unit.endByte,
  );
  const span = createSourceSpan(artifact, unit, range.startByte, range.endByte);
  if (input.sourceUnitId !== span.sourceUnitId || input.id !== span.id) {
    throw new ValidationError(
      'Source span identity does not match the unit and range',
    );
  }
  return span;
}

export function resolveSourceUnit(
  artifact: Artifact,
  value: unknown,
): Uint8Array {
  const unit = parseSourceUnit(value, artifact);
  return artifact.slice(unit.startByte, unit.endByte);
}

export function resolveSourceSpan(
  artifact: Artifact,
  sourceUnit: unknown,
  value: unknown,
): Uint8Array {
  const unit = parseSourceUnit(sourceUnit, artifact);
  const span = parseSourceSpan(value, artifact, unit);
  return artifact.slice(span.startByte, span.endByte);
}
