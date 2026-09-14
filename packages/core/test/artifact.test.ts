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
