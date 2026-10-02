import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeStateRevision,
  extractLocators,
  hasValidLines,
  parseLocator,
  parseStateId,
  parseStateRevision,
  stateIdOf,
  ValidationError,
} from '@sulai/core';

const ABC =
  'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const OCCURRENCE = `occurrence:v1:${'0'.repeat(64)}`;

function golden() {
  return {
    format: 'sulai.state',
    version: 1,
    parent: null as string | null,
    createdAt: '2026-01-02T03:04:05.006Z',
    page: ABC,
    occurrence: OCCURRENCE,
    references: [
      {
        locator: 'r1/a.md#L1-L2',
        status: 'resolved',
        artifact: ABC,
        startByte: 0,
        endByte: 5,
      },
      { locator: 'r9/x.md#L1', status: 'unresolved', reason: 'unknown-root' },
    ] as Record<string, unknown>[],
  };
}

// Written out by hand, and hashed with an independent tool.
const GOLDEN_TEXT = `{"format":"sulai.state","version":1,"parent":null,"createdAt":"2026-01-02T03:04:05.006Z","page":"${ABC}","occurrence":"${OCCURRENCE}","references":[{"locator":"r1/a.md#L1-L2","status":"resolved","artifact":"${ABC}","startByte":0,"endByte":5},{"locator":"r9/x.md#L1","status":"unresolved","reason":"unknown-root"}]}\n`;
const GOLDEN_ID =
  'state:v1:9cfec85cfe494dcfb7e908208fadae4c7b169453114209b86371839d988af189';

test('a state revision has exactly one encoding, and its identity is the hash of it', () => {
  const { id, bytes, revision } = encodeStateRevision(golden());
  assert.equal(Buffer.from(bytes).toString('utf8'), GOLDEN_TEXT);
  assert.equal(bytes.byteLength, 510);
  assert.equal(id, GOLDEN_ID);
  assert.equal(stateIdOf(bytes, 1), GOLDEN_ID);
  assert.deepEqual(parseStateRevision(bytes), revision);
  assert.equal(Object.isFrozen(revision.references[0]), true);
  assert.equal(parseStateId(GOLDEN_ID), GOLDEN_ID);
});

test('a version 2 revision may name records of either version', () => {
  const occurrence = `occurrence:v2:${'0'.repeat(64)}`;
  const value = {
    ...golden(),
    version: 2,
    parent: GOLDEN_ID,
    occurrence,
    references: [
      {
        locator: 'r2/bin/run#L1',
        status: 'resolved',
        artifact: ABC,
        startByte: 0,
        endByte: 3,
      },
    ],
  };
  // Written out by hand, and hashed with `sha256sum`.
  const text = `{"format":"sulai.state","version":2,"parent":"${GOLDEN_ID}","createdAt":"2026-01-02T03:04:05.006Z","page":"${ABC}","occurrence":"${occurrence}","references":[{"locator":"r2/bin/run#L1","status":"resolved","artifact":"${ABC}","startByte":0,"endByte":3}]}\n`;
  const id =
    'state:v2:d1f7d01d466c18d8bbae154e34868fc19e7f40f774cf60c12baff2278d11d008';
  const encoded = encodeStateRevision(value);
  assert.equal(Buffer.from(encoded.bytes).toString('utf8'), text);
  assert.equal(encoded.id, id);
  assert.equal(stateIdOf(encoded.bytes, 2), id);
  assert.deepEqual(parseStateRevision(Buffer.from(text)), value);
  assert.equal(parseStateId(id), id);
  // Version 1 names only version 1 records.
  for (const older of [
    { ...value, version: 1 },
    { ...value, version: 1, occurrence: OCCURRENCE, parent: id },
  ]) {
    assert.throws(
      () => encodeStateRevision(older),
      /names only version 1 records/,
    );
  }
  assert.throws(() => parseStateId(id.replace('v2', 'v4')), ValidationError);
});

test('locators name a root, a path and lines, and nothing else is a reference', () => {
  assert.deepEqual(parseLocator('r1/docs/README.md#L14-L20'), {
    root: 'r1',
    path: 'docs/README.md',
    startLine: 14,
    endLine: 20,
  });
  assert.deepEqual(parseLocator('r12/a b/c.md#L3'), {
    root: 'r12',
    path: 'a b/c.md',
    startLine: 3,
    endLine: 3,
  });
  assert.deepEqual(parseLocator('r2#L1-L4'), {
    root: 'r2',
    path: '',
    startLine: 1,
    endLine: 4,
  });
  for (const text of [
    'README.md#L1',
    'r0/a.md#L1',
    'r1/a.md',
    'r1/a.md#1',
    'r1/a.md#L1-2',
    'notes/log.md:12',
    'npm test',
  ]) {
    assert.equal(parseLocator(text), null, text);
  }
  assert.equal(
    hasValidLines({ root: 'r1', path: 'a', startLine: 2, endLine: 3 }),
    true,
  );
  assert.equal(
    hasValidLines({ root: 'r1', path: 'a', startLine: 0, endLine: 3 }),
    false,
  );
  assert.equal(
    hasValidLines({ root: 'r1', path: 'a', startLine: 4, endLine: 3 }),
    false,
  );
});

test('a page cites exactly its locator code spans, in order and once each', () => {
  const page = [
    '# Status',
    '- Shipped `r1/a.md#L1-L2` and `r2#L3`, tested with `npm test`.',
    '- Again `r1/a.md#L1-L2`; also `r4/b.md#L0` and `r1/c d.md#L5`.',
    '```',
    'not a span',
    '```',
  ].join('\n');
  assert.deepEqual(extractLocators(page), [
    'r1/a.md#L1-L2',
    'r2#L3',
    'r4/b.md#L0',
    'r1/c d.md#L5',
  ]);
  assert.deepEqual(extractLocators('no references here'), []);
});

test('state revisions are validated strictly on encoding and parsing', () => {
  const variant = (change: (value: ReturnType<typeof golden>) => void) => {
    const value = golden();
    change(value);
    return value;
  };
  const invalid: Array<[string, unknown, RegExp]> = [
    ['unknown field', { ...golden(), extra: 1 }, /missing or unknown fields/],
    ['format', variant((v) => (v.format = 'sulai.other')), /format or version/],
    ['parent', variant((v) => (v.parent = 'state:v1:abc')), /Invalid state ID/],
    ['createdAt', variant((v) => (v.createdAt = '2026-01-02')), /ISO 8601/],
    ['page', variant((v) => (v.page = 'sha256:abc')), /Invalid artifact ID/],
    [
      'occurrence',
      variant((v) => (v.occurrence = ABC)),
      /Invalid occurrence ID/,
    ],
    [
      'status',
      variant(
        (v) => ((v.references[1] as Record<string, unknown>).status = 'maybe'),
      ),
      /status is not a recognized/,
    ],
    [
      'reason',
      variant(
        (v) =>
          ((v.references[1] as Record<string, unknown>).reason = 'unknown'),
      ),
      /Unresolved reason/,
    ],
    [
      'locator',
      variant(
        (v) =>
          ((v.references[0] as Record<string, unknown>).locator = 'a.md:1'),
      ),
      /not a locator/,
    ],
    [
      'range order',
      variant(
        (v) => ((v.references[0] as Record<string, unknown>).endByte = -1),
      ),
      /in-order byte range/,
    ],
    [
      'resolved without artifact',
      variant(
        (v) => delete (v.references[0] as Record<string, unknown>).artifact,
      ),
      /missing or unknown fields/,
    ],
    [
      'duplicate locator',
      variant((v) => (v.references[1] = { ...(v.references[0] as object) })),
      /recorded once/,
    ],
  ];
  for (const [label, value, reason] of invalid) {
    const refused = (error: unknown) =>
      error instanceof ValidationError && reason.test(error.message);
    assert.throws(
      () => encodeStateRevision(value),
      refused,
      `encode: ${label}`,
    );
    assert.throws(
      () => parseStateRevision(Buffer.from(`${JSON.stringify(value)}\n`)),
      refused,
      `parse: ${label}`,
    );
  }
  for (const bytes of [
    Buffer.from(GOLDEN_TEXT.trimEnd()),
    Buffer.from(`${JSON.stringify(golden(), null, 1)}\n`),
    Buffer.from('not json\n'),
  ]) {
    assert.throws(() => parseStateRevision(bytes), ValidationError);
  }
  for (const value of [
    null,
    '',
    GOLDEN_ID.toUpperCase(),
    `${GOLDEN_ID}0`,
    ABC,
  ]) {
    assert.throws(() => parseStateId(value), ValidationError, String(value));
  }
});

test('a version 3 revision may name records of any version, and version 2 may not name version 3', () => {
  const occurrence = `occurrence:v3:${'0'.repeat(64)}`;
  const parent =
    'state:v2:d1f7d01d466c18d8bbae154e34868fc19e7f40f774cf60c12baff2278d11d008';
  const value = {
    ...golden(),
    version: 3,
    parent,
    occurrence,
    references: [
      {
        locator: 'r1/src/config.js#L1',
        status: 'resolved',
        artifact: ABC,
        startByte: 0,
        endByte: 3,
      },
    ],
  };
  // Written out by hand, and hashed with `sha256sum`.
  const text = `{"format":"sulai.state","version":3,"parent":"${parent}","createdAt":"2026-01-02T03:04:05.006Z","page":"${ABC}","occurrence":"${occurrence}","references":[{"locator":"r1/src/config.js#L1","status":"resolved","artifact":"${ABC}","startByte":0,"endByte":3}]}\n`;
  const id =
    'state:v3:ed66a782af035399c42e1aafc23db265788a5f592145b530138cf20ecf313806';
  const encoded = encodeStateRevision(value);
  assert.equal(Buffer.from(encoded.bytes).toString('utf8'), text);
  assert.equal(encoded.id, id);
  assert.equal(stateIdOf(encoded.bytes, 3), id);
  assert.deepEqual(parseStateRevision(Buffer.from(text)), value);
  assert.equal(parseStateId(id), id);
  // Version 2 names only version 1 or 2 records.
  for (const older of [
    { ...value, version: 2 },
    { ...value, version: 2, occurrence: OCCURRENCE, parent: id },
  ]) {
    assert.throws(
      () => encodeStateRevision(older),
      /names only version 1 or 2 records/,
    );
  }
});
