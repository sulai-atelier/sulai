import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Artifact,
  createSourceSpan,
  createSourceUnit,
  parseSourceSpan,
  parseSourceUnit,
  resolveSourceSpan,
  resolveSourceUnit,
  ValidationError,
} from '@sulai/core';

test('version 1 source IDs match fixed serialization vectors', () => {
  const artifact = new Artifact(Buffer.from('abc'));
  const unit = createSourceUnit(artifact, 0, 3);
  assert.equal(
    unit.id,
    'source-unit:v1:13f7a60ad63a39881e59a57a4c1ea2287743d0280a693f8cb349785abe62e63e',
  );
  assert.equal(
    createSourceSpan(artifact, unit, 1, 3).id,
    'source-span:v1:a11f0bb4c6b7192ee71b4cf058d6bf463bd0941bdcd37a29672b984baf2f461f',
  );
});

test('source identity is stable across reconstruction and depends on location and parent', () => {
  const artifact = new Artifact(Buffer.from('same same'));
  const first = createSourceUnit(artifact, 0, 4);
  const second = createSourceUnit(artifact, 5, 9);
  assert.deepEqual(
    first,
    createSourceUnit(new Artifact(artifact.bytes()), 0, 4),
  );
  assert.notEqual(first.id, second.id);
  assert.notEqual(
    first.id,
    createSourceUnit(new Artifact(Buffer.from('same other')), 0, 4).id,
  );
  assert.deepEqual(
    resolveSourceUnit(artifact, first),
    resolveSourceUnit(artifact, second),
  );
  const span = createSourceSpan(artifact, first, 0, 2);
  assert.deepEqual(span, createSourceSpan(artifact, first, 0, 2));
  assert.notEqual(span.id, createSourceSpan(artifact, first, 1, 3).id);
  assert.notEqual(
    span.id,
    createSourceSpan(artifact, createSourceUnit(artifact, 0, 9), 0, 2).id,
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(span), true);
});

test('serialized references resolve exact bytes with absolute, half-open coordinates', () => {
  const original = Buffer.from('prefix:🌱 café\r\nend');
  const artifact = new Artifact(original);
  const unit = createSourceUnit(artifact, 7, original.byteLength - 3);
  const span = createSourceSpan(artifact, unit, 7, 11);
  const serializedUnit: unknown = JSON.parse(JSON.stringify(unit));
  const serializedSpan: unknown = JSON.parse(JSON.stringify(span));
  assert.deepEqual(parseSourceUnit(serializedUnit, artifact), unit);
  assert.deepEqual(parseSourceSpan(serializedSpan, artifact, unit), span);
  assert.deepEqual(
    Buffer.from(resolveSourceUnit(artifact, serializedUnit)),
    Buffer.from('🌱 café\r\n'),
  );
  assert.deepEqual(
    Buffer.from(resolveSourceSpan(artifact, serializedUnit, serializedSpan)),
    Buffer.from('🌱'),
  );
  const partialByte = createSourceSpan(artifact, unit, 7, 8);
  assert.deepEqual(
    resolveSourceSpan(artifact, unit, partialByte),
    new Uint8Array([0xf0]),
  );
  resolveSourceUnit(artifact, unit).fill(0);
  assert.deepEqual(Buffer.from(artifact.bytes()), original);
});

test('invalid, empty, fractional, and out-of-bounds ranges are rejected', () => {
  const artifact = new Artifact(Buffer.from('0123456789'));
  const unit = createSourceUnit(artifact, 2, 8);
  for (const [start, end] of [
    [-1, 2],
    [0, 11],
    [2, 2],
    [3, 2],
    [0.5, 2],
    [0, NaN],
    [0, Infinity],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ] as const) {
    assert.throws(
      () => createSourceUnit(artifact, start, end),
      ValidationError,
    );
  }
  for (const [start, end] of [
    [1, 3],
    [3, 9],
    [3, 3],
  ] as const) {
    assert.throws(
      () => createSourceSpan(artifact, unit, start, end),
      ValidationError,
    );
  }
});

test('untrusted references cannot change their identity, artifact, parent, or bounds', () => {
  const artifact = new Artifact(Buffer.from('0123456789'));
  const unit = createSourceUnit(artifact, 2, 8);
  const span = createSourceSpan(artifact, unit, 3, 6);
  for (const value of [
    null,
    [],
    {},
    { ...unit, extra: true },
    { ...unit, id: 'invalid' },
    { ...unit, artifactId: new Artifact(Buffer.from('other')).id },
    { ...unit, startByte: '2' },
    { ...unit, endByte: 7 },
  ]) {
    assert.throws(() => resolveSourceUnit(artifact, value), ValidationError);
  }
  for (const value of [
    null,
    [],
    {},
    { ...span, extra: true },
    { ...span, id: 'invalid' },
    { ...span, sourceUnitId: createSourceUnit(artifact, 0, 10).id },
    { ...span, startByte: 1 },
    { ...span, endByte: 9 },
    { ...span, endByte: '6' },
    { ...span, startByte: 4 },
  ]) {
    assert.throws(
      () => resolveSourceSpan(artifact, unit, value),
      ValidationError,
    );
  }
  assert.throws(
    () => resolveSourceUnit(new Artifact(Buffer.from('abcdefghij')), unit),
    ValidationError,
  );
  assert.throws(
    () => resolveSourceSpan(artifact, { ...unit, endByte: 9 }, span),
    ValidationError,
  );
});

test('resolving a reference never materializes the whole artifact', (t) => {
  // The performance invariant that motivated Artifact.slice(). Asserting the
  // returned length would pass even if the implementation copied everything
  // first, so this locks the mechanism: the resolvers must not call bytes().
  const artifact = new Artifact(Buffer.from('abcdefghij'));
  const unit = createSourceUnit(artifact, 2, 8);
  const span = createSourceSpan(artifact, unit, 3, 6);

  const bytesSpy = t.mock.method(Artifact.prototype, 'bytes');
  const sliceSpy = t.mock.method(Artifact.prototype, 'slice');
  t.after(() => {
    bytesSpy.mock.restore();
    sliceSpy.mock.restore();
  });

  // Resolvers return Uint8Array; strict deepEqual distinguishes that from Buffer.
  assert.deepEqual(
    resolveSourceUnit(artifact, unit),
    Uint8Array.from(Buffer.from('cdefgh')),
  );
  assert.deepEqual(
    resolveSourceSpan(artifact, unit, span),
    Uint8Array.from(Buffer.from('def')),
  );

  assert.equal(
    bytesSpy.mock.callCount(),
    0,
    'resolvers must not copy the whole artifact',
  );
  assert.equal(sliceSpy.mock.callCount(), 2, 'each resolver copies one range');
  assert.deepEqual(sliceSpy.mock.calls[0]?.arguments, [2, 8]);
  assert.deepEqual(sliceSpy.mock.calls[1]?.arguments, [3, 6]);
});
