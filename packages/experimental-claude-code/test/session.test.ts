import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Artifact, resolveSourceUnit, ValidationError } from '@sulai/core';
import {
  CLAUDE_CODE_SESSION_READER,
  MAX_SESSION_BYTES,
  readClaudeCodeSession,
} from '../dist/index.js';

const fixture = fileURLToPath(
  new URL(
    '../../../fixtures/synthetic.claude-code-session.jsonl',
    import.meta.url,
  ),
);
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function readFixture() {
  const artifact = new Artifact(await readFile(fixture));
  return { artifact, reading: readClaudeCodeSession(artifact) };
}

function recordAt(
  reading: ReturnType<typeof readClaudeCodeSession>,
  line: number,
) {
  const record = reading.records.find((r) => r.line === line);
  assert.ok(record, `no record at line ${line}`);
  return record;
}

test('the fixture yields every record, including the torn final line', async () => {
  const { artifact, reading } = await readFixture();
  assert.equal(reading.reader, CLAUDE_CODE_SESSION_READER);
  assert.equal(reading.artifactId, artifact.id);
  assert.equal(reading.records.length, 14);
  assert.deepEqual(
    reading.records.map((r) => r.kind),
    [
      'metadata',
      'message',
      'message',
      'message',
      'message',
      'message',
      'message',
      'message',
      'message',
      'message',
      'metadata',
      'message',
      'unknown',
      'unparseable',
    ],
  );
  assert.deepEqual(reading.blankLines, []);
});

test('the uuid tree reports roots, branch points and unresolved parents', async () => {
  const { reading } = await readFixture();
  assert.deepEqual(reading.roots, [id(2)]);
  // Record 5 has two children, records 6 and 7.
  assert.deepEqual(reading.branchPoints, [id(5), id(7)]);
  assert.deepEqual(reading.unresolvedParents, [id(99)]);
  assert.deepEqual(reading.duplicateUuids, []);
  assert.deepEqual(reading.unknownTypes, ['synthetic-future-record']);
});

test('message records expose structure: role, block types, sidechain, agent', async () => {
  const { reading } = await readFixture();
  assert.deepEqual(recordAt(reading, 2).contentBlocks, ['string']);
  assert.equal(recordAt(reading, 2).role, 'user');
  assert.deepEqual(recordAt(reading, 3).contentBlocks, ['thinking', 'text']);
  assert.deepEqual(recordAt(reading, 4).contentBlocks, ['tool_use']);
  assert.deepEqual(recordAt(reading, 5).contentBlocks, ['tool_result']);
  const sidechain = recordAt(reading, 8);
  assert.equal(sidechain.isSidechain, true);
  assert.equal(sidechain.agentId, 'a0000000000000001');
  assert.equal(recordAt(reading, 3).isSidechain, false);
  assert.equal(recordAt(reading, 3).timestamp, '2026-01-01T00:00:03.000Z');
});

test('every source unit resolves to the exact bytes of its line', async () => {
  const { artifact, reading } = await readFixture();
  const raw = await readFile(fixture);
  const lines = raw.toString('utf8').split('\n');
  for (const record of reading.records) {
    const resolved = Buffer.from(
      resolveSourceUnit(artifact, record.sourceUnit),
    ).toString('utf8');
    assert.equal(resolved, lines[record.line - 1], `line ${record.line}`);
    assert.equal(record.sourceUnit.artifactId, artifact.id);
  }
  // The units plus their delimiters account for every byte of the artifact.
  const covered = reading.records.reduce(
    (sum, r) => sum + (r.sourceUnit.endByte - r.sourceUnit.startByte),
    0,
  );
  const newlines = raw.filter((b) => b === 0x0a).length;
  assert.equal(covered + newlines, artifact.byteLength);
});

test('the reading never contains message text', async () => {
  const { reading } = await readFixture();
  const serialized = JSON.stringify(reading);
  for (const secret of [
    'Synthetic request',
    'Synthetic reasoning',
    'Synthetic plan',
    'Synthetic file body',
    'Synthetic answer',
    'Synthetic subagent note',
    'Synthetic trunc',
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('CRLF delimiters are excluded from source units and blank lines are reported', () => {
  const raw = Buffer.from(
    '{"type":"mode","mode":"x","sessionId":"s"}\r\n\r\n{"type":"ai-title","aiTitle":"t","sessionId":"s"}\r\n',
  );
  const artifact = new Artifact(raw);
  const reading = readClaudeCodeSession(artifact);
  assert.equal(reading.records.length, 2);
  assert.deepEqual(reading.blankLines, [2]);
  for (const record of reading.records) {
    const bytes = resolveSourceUnit(artifact, record.sourceUnit);
    assert.equal(bytes.includes(0x0d), false);
    assert.equal(bytes.includes(0x0a), false);
  }
  assert.deepEqual(
    reading.records.map((r) => r.line),
    [1, 3],
  );
});

test('one unreadable line never hides the rest of the transcript', () => {
  const raw = Buffer.concat([
    Buffer.from('{"type":"mode","mode":"x","sessionId":"s"}\n'),
    Buffer.from([0xff, 0xfe, 0x7b, 0x0a]), // invalid UTF-8
    Buffer.from('[1,2]\n"just a string"\nnull\n'),
    Buffer.from('{"type":"ai-title","aiTitle":"t","sessionId":"s"}\n'),
  ]);
  const reading = readClaudeCodeSession(new Artifact(raw));
  assert.deepEqual(
    reading.records.map((r) => r.kind),
    [
      'metadata',
      'unparseable',
      'unparseable',
      'unparseable',
      'unparseable',
      'metadata',
    ],
  );
});

test('an absent parentUuid is not a root; only an explicit null is', () => {
  const raw = Buffer.from(
    [
      JSON.stringify({ type: 'user', uuid: 'a', parentUuid: null }),
      JSON.stringify({ type: 'user', uuid: 'b' }),
      JSON.stringify({ type: 'user', uuid: 'a', parentUuid: 'b' }),
    ].join('\n'),
  );
  const reading = readClaudeCodeSession(new Artifact(raw));
  assert.deepEqual(reading.roots, ['a']);
  assert.deepEqual(reading.duplicateUuids, ['a']);
  assert.deepEqual(reading.unresolvedParents, []);
});

test('an empty transcript reads as no records', () => {
  const reading = readClaudeCodeSession(new Artifact(new Uint8Array()));
  assert.deepEqual(reading.records, []);
  assert.deepEqual(reading.roots, []);
});

test('a transcript over the reader limit is refused, which is a reader limit only', () => {
  const artifact = new Artifact(new Uint8Array(MAX_SESSION_BYTES + 1));
  assert.throws(
    () => readClaudeCodeSession(artifact),
    (error: unknown) =>
      error instanceof ValidationError &&
      /this reader accepts at most/.test(error.message),
  );
});
