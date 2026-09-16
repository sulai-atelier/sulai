import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Artifact,
  hashContent,
  parseArtifactId,
  ValidationError,
} from '@sulai/core';

test('artifact identity uses SHA-256 of exactly the supplied bytes', () => {
  assert.equal(
    hashContent(Buffer.from('abc')),
    'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    new Artifact(new Uint8Array()).id,
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    new Artifact(Buffer.from('abc')).id,
    new Artifact(Buffer.from('abc')).id,
  );
  assert.notEqual(
    hashContent(Buffer.from('abc\n')),
    hashContent(Buffer.from('abc\r\n')),
  );
  assert.notEqual(
    hashContent(Buffer.from('é')),
    hashContent(Buffer.from('e\u0301')),
  );
});

test('artifacts preserve arbitrary bytes and are isolated from caller mutation', () => {
  const original = new Uint8Array([0, 255, 128, 13, 10]);
  const artifact = new Artifact(original);
  const id = artifact.id;
  original.fill(1);
  artifact.bytes().fill(2);
  assert.deepEqual(artifact.bytes(), new Uint8Array([0, 255, 128, 13, 10]));
  assert.equal(artifact.byteLength, 5);
  assert.equal(artifact.id, id);
  assert.equal(Object.isFrozen(artifact), true);
  assert.throws(() => Object.assign(artifact, { id: 'changed' }), TypeError);
});

test('artifact boundaries reject non-byte content and malformed IDs', () => {
  for (const value of ['abc', null, {}, [1, 2]]) {
    assert.throws(
      () => new Artifact(value as unknown as Uint8Array),
      ValidationError,
    );
    assert.throws(
      () => hashContent(value as unknown as Uint8Array),
      ValidationError,
    );
  }
  for (const value of [
    null,
    1,
    '',
    'sha256:abc',
    `sha256:${'A'.repeat(64)}`,
    '../file',
  ]) {
    assert.throws(() => parseArtifactId(value), ValidationError);
  }
  const artifact = new Artifact(Buffer.from('abc'));
  assert.equal(parseArtifactId(artifact.id), artifact.id);
});

test('artifact IDs reject trailing line terminators', () => {
  const id = hashContent(Buffer.from('synthetic'));
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => parseArtifactId(id + ending), ValidationError);
  }
});

test('slice copies exactly one half-open range and isolates the caller', () => {
  const artifact = new Artifact(new Uint8Array([0, 255, 128, 13, 10]));
  assert.deepEqual(artifact.slice(0, 5), new Uint8Array([0, 255, 128, 13, 10]));
  assert.deepEqual(artifact.slice(1, 3), new Uint8Array([255, 128]));
  assert.deepEqual(artifact.slice(4, 5), new Uint8Array([10]));
  // Half-open: the upper bound is excluded.
  assert.equal(artifact.slice(0, 1).byteLength, 1);
  // Mutating a slice cannot reach the artifact.
  artifact.slice(0, 5).fill(7);
  assert.deepEqual(artifact.bytes(), new Uint8Array([0, 255, 128, 13, 10]));
});

test('slice enforces the same range rules as source references', () => {
  const artifact = new Artifact(Buffer.from('abcdef'));
  for (const [start, end] of [
    [0, 0], // empty
    [3, 3], // empty
    [4, 2], // inverted
    [-1, 3], // below the artifact
    [0, 7], // beyond the artifact
    [0.5, 3], // fractional
    [0, 3.5], // fractional
  ]) {
    assert.throws(() => artifact.slice(start, end), ValidationError);
  }
  for (const value of [null, undefined, '2', {}, NaN, Infinity]) {
    assert.throws(() => artifact.slice(value, 3), ValidationError);
    assert.throws(() => artifact.slice(0, value), ValidationError);
  }
});

test('slice does not materialize the whole artifact', () => {
  // A range read must cost the size of the range, not the size of the artifact,
  // or resolving one reference inside a real export becomes unusable.
  const artifact = new Artifact(new Uint8Array(8 * 1024 * 1024));
  const range = artifact.slice(10, 20);
  assert.equal(range.byteLength, 10);
  assert.equal(artifact.byteLength, 8 * 1024 * 1024);
});
