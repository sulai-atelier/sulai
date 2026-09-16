import { createHash } from 'node:crypto';
import { byteRange, ValidationError } from './validation.js';

export type ArtifactId = `sha256:${string}`;

export function hashContent(bytes: Uint8Array): ArtifactId {
  if (!(bytes instanceof Uint8Array)) {
    throw new ValidationError('Artifact content must be bytes');
  }
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function parseArtifactId(value: unknown): ArtifactId {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ValidationError('Invalid artifact ID');
  }
  return value as ArtifactId;
}

export class Artifact {
  readonly id: ArtifactId;
  readonly byteLength: number;
  readonly #content: Uint8Array;

  constructor(bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array)) {
      throw new ValidationError('Artifact content must be bytes');
    }
    this.#content = new Uint8Array(bytes);
    this.id = hashContent(this.#content);
    this.byteLength = this.#content.byteLength;
    Object.freeze(this);
  }

  bytes(): Uint8Array {
    return this.#content.slice();
  }

  /**
   * Copies one half-open byte range. Unlike `bytes()`, this never materializes
   * the whole artifact, so resolving a reference into a large artifact costs
   * the size of the range rather than the size of the artifact.
   */
  slice(startByte: unknown, endByte: unknown): Uint8Array {
    const range = byteRange(startByte, endByte, 0, this.byteLength);
    return this.#content.slice(range.startByte, range.endByte);
  }
}
