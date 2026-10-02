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
  assert.equal(occurrenceIdOf(bytes, 1), GOLDEN_ID);
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
    ['version', variant((v) => (v.version = 4)), /format or version/],
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
    GOLDEN_ID.replace('v1', 'v4'),
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

// The Git blob IDs of "abc" and of "bin/run", and the SHA-256 of "bin/run",
// computed with `git hash-object` and `sha256sum`.
const ABC_BLOB = 'f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f';
const LINK_BLOB = 'e08d0670e1da0f198f469c22be19212af7ac5f61';
const LINK =
  'sha256:57b94356302c85712d33811d8bda2a57b5181e3b496466db149873f6ed118265';

function goldenV2() {
  return {
    format: 'sulai.occurrence',
    version: 2,
    nonce: '0123456789abcdef0123456789abcdef',
    startedAt: '2026-01-02T03:04:05.006Z',
    finishedAt: '2026-01-02T03:04:06.007Z',
    status: 'partial',
    roots: [
      {
        id: 'r1',
        source: 'filesystem',
        kind: 'directory',
        platform: 'linux',
        locator: '/synthetic/notes',
      },
      {
        id: 'r2',
        source: 'git',
        objectFormat: 'sha1',
        commit: '1'.repeat(40),
        tree: '2'.repeat(40),
        worktree: 'clean',
        platform: 'linux',
        locator: '/synthetic/repo',
      },
    ] as Record<string, unknown>[],
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
        root: 'r2',
        path: 'bin/run',
        artifact: ABC,
        byteLength: 3,
        mode: '100755',
        blob: ABC_BLOB,
        new: true,
      },
      {
        root: 'r2',
        path: 'link',
        artifact: LINK,
        byteLength: 7,
        mode: '120000',
        blob: LINK_BLOB,
        new: false,
      },
    ] as Record<string, unknown>[],
    skipped: [
      { root: 'r2', path: 'bad�.txt', reason: 'non-utf8-name' },
    ] as Record<string, unknown>[],
    excluded: [
      {
        root: 'r2',
        path: 'vendor/lib',
        reason: 'submodule',
        commit: '3'.repeat(40),
      },
    ] as Record<string, unknown>[],
  };
}

type GoldenV2 = ReturnType<typeof goldenV2>;

// Written out by hand, and hashed with `sha256sum`.
const GOLDEN_V2_TEXT = `{"format":"sulai.occurrence","version":2,"nonce":"0123456789abcdef0123456789abcdef","startedAt":"2026-01-02T03:04:05.006Z","finishedAt":"2026-01-02T03:04:06.007Z","status":"partial","roots":[{"id":"r1","source":"filesystem","kind":"directory","platform":"linux","locator":"/synthetic/notes"},{"id":"r2","source":"git","objectFormat":"sha1","commit":"${'1'.repeat(40)}","tree":"${'2'.repeat(40)}","worktree":"clean","platform":"linux","locator":"/synthetic/repo"}],"entries":[{"root":"r1","path":"a.txt","artifact":"${ABC}","byteLength":3,"modifiedAt":"2026-01-01T00:00:00.000Z","new":true},{"root":"r2","path":"bin/run","artifact":"${ABC}","byteLength":3,"mode":"100755","blob":"${ABC_BLOB}","new":true},{"root":"r2","path":"link","artifact":"${LINK}","byteLength":7,"mode":"120000","blob":"${LINK_BLOB}","new":false}],"skipped":[{"root":"r2","path":"bad�.txt","reason":"non-utf8-name"}],"excluded":[{"root":"r2","path":"vendor/lib","reason":"submodule","commit":"${'3'.repeat(40)}"}]}\n`;
const GOLDEN_V2_ID =
  'occurrence:v2:154f9f82f8882451842215467f2f6439d190efa1a68a97c030e8e8d9534bd27b';

function variantV2(change: (value: GoldenV2) => void): GoldenV2 {
  const value = goldenV2();
  change(value);
  return value;
}

test('a version 2 occurrence mixes folder and Git roots, with one encoding', () => {
  const { id, bytes, occurrence } = encodeOccurrence(goldenV2());
  assert.equal(Buffer.from(bytes).toString('utf8'), GOLDEN_V2_TEXT);
  assert.equal(bytes.byteLength, 1308);
  assert.equal(id, GOLDEN_V2_ID);
  assert.equal(occurrenceIdOf(bytes, 2), GOLDEN_V2_ID);
  assert.deepEqual(parseOccurrence(bytes), occurrence);
  assert.deepEqual(parseOccurrence(Buffer.from(GOLDEN_V2_TEXT)), goldenV2());
  assert.equal(parseOccurrenceId(GOLDEN_V2_ID), GOLDEN_V2_ID);
  // A version 1 record is still read as written, with no source on its roots.
  const v1 = parseOccurrence(Buffer.from(GOLDEN_TEXT));
  assert.equal(v1.version, 1);
  assert.equal('source' in (v1.roots[0] as object), false);
});

test('every version 2 rule is enforced on both encoding and parsing', () => {
  const root = (v: GoldenV2, index: number) =>
    v.roots[index] as Record<string, unknown>;
  const entry = (v: GoldenV2, index: number) =>
    v.entries[index] as Record<string, unknown>;
  const invalid: Array<[string, unknown, RegExp]> = [
    [
      'root without a source',
      variantV2((v) => delete root(v, 0).source),
      /root source/,
    ],
    [
      'unknown source',
      variantV2((v) => (root(v, 1).source = 'svn')),
      /root source/,
    ],
    [
      'Git root with a kind',
      variantV2((v) => (root(v, 1).kind = 'directory')),
      /missing or unknown fields/,
    ],
    [
      'object format',
      variantV2((v) => (root(v, 1).objectFormat = 'md5')),
      /Git object format/,
    ],
    [
      'short commit',
      variantV2((v) => (root(v, 1).commit = '1'.repeat(12))),
      /full sha1 object ID/,
    ],
    [
      'sha256 commit in a sha1 repository',
      variantV2((v) => (root(v, 1).commit = '1'.repeat(64))),
      /full sha1 object ID/,
    ],
    [
      'uppercase tree',
      variantV2((v) => (root(v, 1).tree = 'A'.repeat(40))),
      /lowercase object ID/,
    ],
    [
      'worktree',
      variantV2((v) => (root(v, 1).worktree = 'dirty')),
      /Git root worktree/,
    ],
    [
      'Git entry with a modification time',
      variantV2((v) => {
        delete entry(v, 1).mode;
        entry(v, 1).modifiedAt = '2026-01-01T00:00:00.000Z';
      }),
      /missing or unknown fields/,
    ],
    [
      'folder entry with a blob',
      variantV2((v) => (entry(v, 0).blob = ABC_BLOB)),
      /missing or unknown fields/,
    ],
    [
      'tree mode',
      variantV2((v) => (entry(v, 1).mode = '040000')),
      /Git entry mode/,
    ],
    [
      'blob length',
      variantV2((v) => (entry(v, 1).blob = ABC_BLOB.slice(1))),
      /full sha1 object ID/,
    ],
    [
      'one blob, two artifacts',
      variantV2((v) => (entry(v, 2).blob = ABC_BLOB)),
      /disagree about which bytes a blob holds/,
    ],
    [
      'empty path in a Git root',
      variantV2((v) => (entry(v, 1).path = '')),
      /relative, \/-separated and normalized/,
    ],
    [
      'Git root skipping a link',
      variantV2(
        (v) => ((v.skipped[0] as { reason: string }).reason = 'symbolic-link'),
      ),
      /skips only names that are not valid UTF-8/,
    ],
    [
      'Git root excluding the store',
      variantV2((v) => {
        v.excluded = [{ root: 'r2', path: '.sulai', reason: 'project-store' }];
      }),
      /excludes only submodules/,
    ],
    [
      'folder root excluding a submodule',
      variantV2((v) => {
        v.excluded = [{ root: 'r1', path: 'lib', reason: 'submodule' }];
      }),
      /A folder root excludes only the project store/,
    ],
    [
      'submodule without its commit',
      variantV2((v) => delete (v.excluded[0] as { commit?: string }).commit),
      /missing or unknown fields/,
    ],
    [
      'inside a submodule',
      variantV2((v) => (entry(v, 2).path = 'vendor/lib/x')),
      /inside an excluded/,
    ],
    [
      'Git root in version 1',
      variantV2((v) => {
        v.version = 1;
        delete root(v, 0).source;
      }),
      /missing or unknown fields/,
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

test('a sha256 repository records full sha256 object IDs', () => {
  // The blob ID of "abc" in a sha256 repository, from `git hash-object`.
  const blob =
    'c1cf6e465077930e88dc5136641d402f72a229ddd996f627d60e9639eaba35a6';
  const value = variantV2((v) => {
    Object.assign(v.roots[1] as object, {
      objectFormat: 'sha256',
      commit: '1'.repeat(64),
      tree: '2'.repeat(64),
    });
    const [file, run] = v.entries as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    v.entries = [file, { ...run, blob }];
    v.skipped = [];
    v.status = 'complete';
    v.excluded = [];
  });
  assert.equal(encodeOccurrence(value).occurrence.roots.length, 2);
  assert.throws(
    () =>
      encodeOccurrence({
        ...value,
        entries: [value.entries[0], { ...value.entries[1], blob: ABC_BLOB }],
      }),
    /full sha256 object ID/,
  );
});

function goldenV3() {
  return {
    format: 'sulai.occurrence',
    version: 3,
    nonce: '0123456789abcdef0123456789abcdef',
    startedAt: '2026-01-02T03:04:05.006Z',
    finishedAt: '2026-01-02T03:04:06.007Z',
    status: 'partial',
    roots: [
      {
        id: 'r1',
        source: 'git-worktree',
        objectFormat: 'sha1',
        head: '1'.repeat(40) as string | null,
        tree: '2'.repeat(40) as string | null,
        selection: 'tracked-and-unignored',
        platform: 'linux',
        locator: '/synthetic/repo',
      },
      {
        id: 'r2',
        source: 'git-worktree',
        objectFormat: 'sha1',
        head: null,
        tree: null,
        selection: 'tracked-and-unignored',
        platform: 'linux',
        locator: '/synthetic/fresh',
      },
    ] as Record<string, unknown>[],
    entries: [
      {
        root: 'r1',
        path: 'src/config.js',
        artifact: ABC,
        byteLength: 3,
        modifiedAt: '2026-01-01T00:00:00.000Z',
        new: true,
      },
      {
        root: 'r2',
        path: 'notes.md',
        artifact: ABC,
        byteLength: 3,
        modifiedAt: '2026-01-01T00:00:00.000Z',
        new: true,
      },
    ] as Record<string, unknown>[],
    skipped: [{ root: 'r1', path: 'link', reason: 'symbolic-link' }] as Record<
      string,
      unknown
    >[],
    excluded: [
      { root: 'r1', path: '.sulai', reason: 'project-store' },
      { root: 'r1', path: 'scratch', reason: 'nested-repository' },
      {
        root: 'r1',
        path: 'vendor/lib',
        reason: 'submodule',
        commit: '3'.repeat(40),
      },
    ] as Record<string, unknown>[],
  };
}

type GoldenV3 = ReturnType<typeof goldenV3>;

// Written out by hand, and hashed with `sha256sum`.
const GOLDEN_V3_TEXT = `{"format":"sulai.occurrence","version":3,"nonce":"0123456789abcdef0123456789abcdef","startedAt":"2026-01-02T03:04:05.006Z","finishedAt":"2026-01-02T03:04:06.007Z","status":"partial","roots":[{"id":"r1","source":"git-worktree","objectFormat":"sha1","head":"${'1'.repeat(40)}","tree":"${'2'.repeat(40)}","selection":"tracked-and-unignored","platform":"linux","locator":"/synthetic/repo"},{"id":"r2","source":"git-worktree","objectFormat":"sha1","head":null,"tree":null,"selection":"tracked-and-unignored","platform":"linux","locator":"/synthetic/fresh"}],"entries":[{"root":"r1","path":"src/config.js","artifact":"${ABC}","byteLength":3,"modifiedAt":"2026-01-01T00:00:00.000Z","new":true},{"root":"r2","path":"notes.md","artifact":"${ABC}","byteLength":3,"modifiedAt":"2026-01-01T00:00:00.000Z","new":true}],"skipped":[{"root":"r1","path":"link","reason":"symbolic-link"}],"excluded":[{"root":"r1","path":".sulai","reason":"project-store"},{"root":"r1","path":"scratch","reason":"nested-repository"},{"root":"r1","path":"vendor/lib","reason":"submodule","commit":"${'3'.repeat(40)}"}]}\n`;
const GOLDEN_V3_ID =
  'occurrence:v3:819a2c5b409ccd60b86c033902c1830785b1b2cbf53ff606b942d4995c60f052';

function variantV3(change: (value: GoldenV3) => void): GoldenV3 {
  const value = goldenV3();
  change(value);
  return value;
}

test('a version 3 occurrence records working trees, with one encoding', () => {
  const { id, bytes, occurrence } = encodeOccurrence(goldenV3());
  assert.equal(Buffer.from(bytes).toString('utf8'), GOLDEN_V3_TEXT);
  assert.equal(bytes.byteLength, 1283);
  assert.equal(id, GOLDEN_V3_ID);
  assert.equal(occurrenceIdOf(bytes, 3), GOLDEN_V3_ID);
  assert.deepEqual(parseOccurrence(bytes), occurrence);
  assert.deepEqual(parseOccurrence(Buffer.from(GOLDEN_V3_TEXT)), goldenV3());
  assert.equal(parseOccurrenceId(GOLDEN_V3_ID), GOLDEN_V3_ID);
  // Earlier versions are still read as written.
  assert.equal(parseOccurrence(Buffer.from(GOLDEN_V2_TEXT)).version, 2);
  assert.equal(parseOccurrence(Buffer.from(GOLDEN_TEXT)).version, 1);
});

test('every version 3 rule is enforced on both encoding and parsing', () => {
  const root = (v: GoldenV3, index: number) =>
    v.roots[index] as Record<string, unknown>;
  const invalid: Array<[string, unknown, RegExp]> = [
    [
      'working tree in version 2',
      variantV3((v) => (v.version = 2)),
      /root source/,
    ],
    [
      'head without its tree',
      variantV3((v) => (root(v, 0).tree = null)),
      /HEAD and its tree, or neither/,
    ],
    [
      'short head',
      variantV3((v) => (root(v, 0).head = '1'.repeat(39))),
      /full sha1 object ID/,
    ],
    [
      'unknown selection',
      variantV3((v) => (root(v, 0).selection = 'everything')),
      /Working-tree selection/,
    ],
    [
      'a commit field on a working tree',
      variantV3((v) => (root(v, 0).commit = '1'.repeat(40))),
      /missing or unknown fields/,
    ],
    [
      'a blob on a working-tree entry',
      variantV3((v) => {
        v.entries[0] = { ...v.entries[0], blob: ABC_BLOB };
      }),
      /missing or unknown fields/,
    ],
    [
      'submodule without its commit',
      variantV3((v) => delete (v.excluded[2] as { commit?: string }).commit),
      /missing or unknown fields/,
    ],
    [
      'inside a nested repository',
      variantV3((v) => ((v.entries[0] as { path: string }).path = 'scratch/x')),
      /inside an excluded/,
    ],
    [
      'folder root excluding a nested repository',
      variantV3((v) => {
        v.roots[0] = {
          id: 'r1',
          source: 'filesystem',
          kind: 'directory',
          platform: 'linux',
          locator: '/synthetic/repo',
        };
        v.excluded = [v.excluded[1] as Record<string, unknown>];
      }),
      /A folder root excludes only the project store/,
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
