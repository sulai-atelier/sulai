import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeOccurrence,
  occurrenceIdOf,
  parseOccurrence,
  parseOccurrenceId,
  ValidationError,
} from '@sulai/core';

const ABC =
  'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function golden() {
  return {
    format: 'sulai.occurrence',
    version: 1,
    nonce: '0123456789abcdef0123456789abcdef',
    startedAt: '2026-01-02T03:04:05.006Z',
    finishedAt: '2026-01-02T03:04:06.007Z',
    status: 'partial',
    roots: [
      {
        id: 'r1',
        kind: 'directory',
        platform: 'linux',
        locator: '/synthetic/root',
      },
    ],
    entries: [
      {
        root: 'r1',
        path: 'a.txt',
        artifact: ABC,
        byteLength: 3,
        modifiedAt: '2026-01-01T00:00:00.000Z',
        new: true,
      },
      {
        root: 'r1',
        path: 'nested/b.txt',
        artifact: ABC,
        byteLength: 3,
        modifiedAt: '2026-01-01T00:00:01.000Z',
        new: true,
      },
    ],
    skipped: [{ root: 'r1', path: 'link', reason: 'symbolic-link' }],
    excluded: [{ root: 'r1', path: 'project/.sulai', reason: 'project-store' }],
  };
}

type Golden = ReturnType<typeof golden>;

// Written out by hand, and its hash computed with an independent tool, so a
// silent change to the encoding fails here rather than passing by construction.
const GOLDEN_TEXT =
  '{"format":"sulai.occurrence","version":1,"nonce":"0123456789abcdef0123456789abcdef","startedAt":"2026-01-02T03:04:05.006Z","finishedAt":"2026-01-02T03:04:06.007Z","status":"partial","roots":[{"id":"r1","kind":"directory","platform":"linux","locator":"/synthetic/root"}],"entries":[{"root":"r1","path":"a.txt","artifact":"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","byteLength":3,"modifiedAt":"2026-01-01T00:00:00.000Z","new":true},{"root":"r1","path":"nested/b.txt","artifact":"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","byteLength":3,"modifiedAt":"2026-01-01T00:00:01.000Z","new":true}],"skipped":[{"root":"r1","path":"link","reason":"symbolic-link"}],"excluded":[{"root":"r1","path":"project/.sulai","reason":"project-store"}]}\n';
const GOLDEN_ID =
  'occurrence:v1:770f51f8cd66323500e4c8f2199fc5e76fbd6e0fbb1581b6f0893557c2a2e601';

const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);

function variant(change: (value: Golden) => void): Golden {
  const value = golden();
  change(value);
  return value;
}

test('an occurrence has exactly one encoding, and its identity is the hash of it', () => {
  const { id, bytes, occurrence } = encodeOccurrence(golden());
  assert.equal(Buffer.from(bytes).toString('utf8'), GOLDEN_TEXT);
  assert.equal(bytes.byteLength, 791);
  assert.equal(id, GOLDEN_ID);
  assert.equal(occurrenceIdOf(bytes), GOLDEN_ID);
  assert.deepEqual(parseOccurrence(bytes), occurrence);
  assert.deepEqual(parseOccurrence(Buffer.from(GOLDEN_TEXT)), golden());
  assert.equal(parseOccurrenceId(GOLDEN_ID), GOLDEN_ID);
});

test('parsed occurrences are frozen all the way down', () => {
  const occurrence = parseOccurrence(Buffer.from(GOLDEN_TEXT));
  assert.equal(Object.isFrozen(occurrence), true);
  assert.equal(Object.isFrozen(occurrence.entries), true);
  assert.equal(Object.isFrozen(occurrence.entries[0]), true);
  assert.equal(Object.isFrozen(occurrence.roots[0]), true);
});

test('bytes that are not the canonical encoding are refused, even when they mean the same', () => {
  const canonical = Buffer.from(GOLDEN_TEXT);
  const refused = [
    Buffer.from(`${JSON.stringify(golden(), null, 2)}\n`),
    Buffer.from(GOLDEN_TEXT.trimEnd()),
    Buffer.from(`${GOLDEN_TEXT}\n`),
    Buffer.from(GOLDEN_TEXT.replace(/\n$/, '\r\n')),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]),
    Buffer.from(GOLDEN_TEXT.replace('"a.txt"', '"\\u0061.txt"')),
    Buffer.from(
      GOLDEN_TEXT.replace(
        '"format":"sulai.occurrence","version":1',
        '"version":1,"format":"sulai.occurrence"',
      ),
    ),
    Buffer.concat([
      canonical.subarray(0, 20),
      Buffer.from([0xff]),
      canonical.subarray(21),
    ]),
    Buffer.from('not json\n'),
  ];
  for (const bytes of refused) {
    assert.throws(
      () => parseOccurrence(bytes),
      ValidationError,
      bytes.toString('utf8').slice(0, 60),
    );
  }
  assert.throws(
    () => parseOccurrence('text' as unknown as Uint8Array),
    ValidationError,
  );
});

test('every structural rule is enforced on both encoding and parsing', () => {
  const entry = (v: Golden, index: number) =>
    v.entries[index] as Record<string, unknown>;
  const root = (v: Golden) => v.roots[0] as Record<string, unknown>;
  const path = /relative, \/-separated and normalized/;
  // Each case names the rule it breaks, so a case cannot pass by tripping a
  // different rule first.
  const invalid: Array<[string, unknown, RegExp]> = [
    [
      'unknown field',
      { ...golden(), extra: true },
      /missing or unknown fields/,
    ],
    [
      'missing field',
      Object.fromEntries(
        Object.entries(golden()).filter(([name]) => name !== 'excluded'),
      ),
      /missing or unknown fields/,
    ],
    ['format', variant((v) => (v.format = 'sulai.other')), /format or version/],
    ['version', variant((v) => (v.version = 2)), /format or version/],
    [
      'uppercase nonce',
      variant((v) => (v.nonce = v.nonce.toUpperCase())),
      /nonce/,
    ],
    ['short nonce', variant((v) => (v.nonce = 'abc')), /nonce/],
    [
      'no milliseconds',
      variant((v) => (v.startedAt = '2026-01-02T03:04:05Z')),
      /ISO 8601/,
    ],
    [
      'offset',
      variant((v) => (v.finishedAt = '2026-01-02T03:04:06.007+00:00')),
      /ISO 8601/,
    ],
    [
      'finished first',
      variant((v) => (v.finishedAt = '2026-01-02T03:04:04.000Z')),
      /finish before/,
    ],
    [
      'complete but skipped',
      variant((v) => (v.status = 'complete')),
      /partial exactly/,
    ],
    [
      'partial but nothing skipped',
      variant((v) => (v.skipped = [])),
      /partial exactly/,
    ],
    ['no roots', variant((v) => (v.roots = [])), /at least one root/],
    ['root numbering', variant((v) => (root(v).id = 'r2')), /numbered r1/],
    [
      'relative locator',
      variant((v) => (root(v).locator = 'synthetic/root')),
      /absolute path/,
    ],
    [
      'posix locator on win32',
      variant((v) => (root(v).platform = 'win32')),
      /absolute path/,
    ],
    ['root kind', variant((v) => (root(v).kind = 'archive')), /root kind/],
    ['unknown root', variant((v) => (entry(v, 0).root = 'r9')), /unknown root/],
    ['parent segment', variant((v) => (entry(v, 0).path = '../a.txt')), path],
    ['current segment', variant((v) => (entry(v, 0).path = './a.txt')), path],
    ['absolute path', variant((v) => (entry(v, 0).path = '/a.txt')), path],
    [
      'empty segment',
      variant((v) => (entry(v, 1).path = 'nested//b.txt')),
      path,
    ],
    ['trailing slash', variant((v) => (entry(v, 1).path = 'nested/')), path],
    [
      'empty path in a directory',
      variant((v) => (entry(v, 0).path = '')),
      path,
    ],
    [
      'lone surrogate',
      variant((v) => (entry(v, 0).path = 'a\ud800.txt')),
      /well-formed/,
    ],
    ['unsorted', variant((v) => v.entries.reverse()), /must be sorted/],
    [
      'duplicate',
      variant((v) => (entry(v, 1).path = 'a.txt')),
      /must be sorted/,
    ],
    [
      'artifact ID',
      variant((v) => (entry(v, 0).artifact = 'sha256:abc')),
      /Invalid artifact ID/,
    ],
    [
      'negative size',
      variant((v) => (entry(v, 0).byteLength = -1)),
      /byteLength/,
    ],
    [
      'fractional size',
      variant((v) => (entry(v, 0).byteLength = 1.5)),
      /byteLength/,
    ],
    [
      'same bytes, other size',
      variant((v) => (entry(v, 1).byteLength = 4)),
      /disagree/,
    ],
    [
      'same bytes, other novelty',
      variant((v) => (entry(v, 1).new = false)),
      /disagree/,
    ],
    [
      'novelty not boolean',
      variant((v) => (entry(v, 0).new = 'yes')),
      /boolean/,
    ],
    [
      'skip reason',
      variant((v) => ((v.skipped[0] as { reason: string }).reason = 'ignored')),
      /Skip reason/,
    ],
    [
      'skipped and captured',
      variant((v) => ((v.skipped[0] as { path: string }).path = 'a.txt')),
      /at most once/,
    ],
    [
      'captured and excluded',
      variant((v) => ((v.excluded[0] as { path: string }).path = 'a.txt')),
      /captured and excluded/,
    ],
    [
      'inside an exclusion',
      variant((v) => (entry(v, 1).path = 'project/.sulai/x')),
      /inside an excluded/,
    ],
    [
      'exclusion reason',
      variant(
        (v) => ((v.excluded[0] as { reason: string }).reason = 'ignored'),
      ),
      /Exclusion reason/,
    ],
  ];
  for (const [label, value, reason] of invalid) {
    const refused = (error: unknown) =>
      error instanceof ValidationError && reason.test(error.message);
    assert.throws(() => encodeOccurrence(value), refused, `encode: ${label}`);
    assert.throws(
      () => parseOccurrence(encode(value)),
      refused,
      `parse: ${label}`,
    );
  }
});

test('a file root records exactly one input, at the empty path', () => {
  const file = {
    ...golden(),
    status: 'complete',
    roots: [
      {
        id: 'r1',
        kind: 'file',
        platform: 'win32',
        locator: 'C:\\synthetic\\a.txt',
      },
    ],
    entries: [{ ...golden().entries[0], path: '' }],
    skipped: [],
    excluded: [],
  };
  const { occurrence } = encodeOccurrence(file);
  assert.equal(occurrence.entries[0]?.path, '');
  assert.throws(
    () =>
      encodeOccurrence({
        ...file,
        entries: [{ ...file.entries[0], path: 'a.txt' }],
      }),
    ValidationError,
  );
  assert.throws(
    () => encodeOccurrence({ ...file, entries: [] }),
    ValidationError,
  );
  assert.throws(
    () =>
      encodeOccurrence({
        ...file,
        excluded: [{ root: 'r1', path: 'x', reason: 'project-store' }],
      }),
    ValidationError,
  );
  // A failed single-file capture is still a recorded event.
  const failed = encodeOccurrence({
    ...file,
    status: 'partial',
    entries: [],
    skipped: [{ root: 'r1', path: '', reason: 'changed-during-read' }],
  });
  assert.equal(failed.occurrence.status, 'partial');
});

test('several roots are representable, each ordered and addressed by id', () => {
  const value = {
    ...golden(),
    roots: [
      ...golden().roots,
      {
        id: 'r2',
        kind: 'directory',
        platform: 'linux',
        locator: '/synthetic/other',
      },
    ],
    entries: [
      ...golden().entries,
      { ...golden().entries[0], root: 'r2', path: 'a.txt' },
    ],
  };
  const { occurrence } = encodeOccurrence(value);
  assert.equal(occurrence.roots.length, 2);
  // Root order comes before path order.
  assert.throws(
    () => encodeOccurrence({ ...value, entries: [...value.entries].reverse() }),
    ValidationError,
  );
});

test('names that are not valid UTF-8 may coincide once decoded, and are still recorded', () => {
  const value = {
    ...golden(),
    skipped: [
      { root: 'r1', path: 'bad\ufffd', reason: 'non-utf8-name' },
      { root: 'r1', path: 'bad\ufffd', reason: 'non-utf8-name' },
      { root: 'r1', path: 'link', reason: 'symbolic-link' },
    ],
  };
  assert.equal(encodeOccurrence(value).occurrence.skipped.length, 3);
  assert.throws(
    () =>
      encodeOccurrence({
        ...golden(),
        skipped: [
          { root: 'r1', path: 'link', reason: 'symbolic-link' },
          { root: 'r1', path: 'link', reason: 'symbolic-link' },
        ],
      }),
    ValidationError,
  );
});

test('occurrence identities are validated', () => {
  for (const value of [
    null,
    '',
    GOLDEN_ID.toUpperCase(),
    GOLDEN_ID.replace('v1', 'v2'),
    `${GOLDEN_ID}0`,
    `sha256:${'a'.repeat(64)}`,
    '../occurrences/x',
  ]) {
    assert.throws(
      () => parseOccurrenceId(value),
      ValidationError,
      String(value),
    );
  }
});
