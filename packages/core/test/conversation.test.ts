import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  CONVERSATION_FORMAT,
  MAX_CONVERSATION_BYTES,
  MAX_CONVERSATION_MESSAGES,
  createSourceSpan,
  importConversation,
  resolveSourceSpan,
  resolveSourceUnit,
  ValidationError,
} from '@sulai/core';

const header = JSON.stringify({ format: CONVERSATION_FORMAT });
const message = '{"role":"user","content":"synthetic"}';

test('the committed fixture is synthetic and stable across repeated imports', async () => {
  const bytes = await readFile(
    new URL('../../../fixtures/synthetic.conversation.jsonl', import.meta.url),
  );
  const first = importConversation(bytes);
  const second = importConversation(bytes);
  assert.equal(first.messages.length, 3);
  assert.equal(first.artifact.id, second.artifact.id);
  assert.deepEqual(first.messages, second.messages);
  assert.deepEqual(Buffer.from(first.artifact.bytes()), bytes);
});

for (const newline of ['\n', '\r\n']) {
  for (const trailingNewline of [false, true]) {
    test(`import preserves whitespace, escapes, and Unicode (${JSON.stringify(newline)}, final=${trailingNewline})`, () => {
      const line =
        '  { "content" : "café 🌱 \\n \\u0061 \\"quoted\\"", "role" : "user" }  ';
      const bytes = Buffer.from(
        `${header}${newline}${line}${trailingNewline ? newline : ''}`,
      );
      const imported = importConversation(bytes);
      assert.deepEqual(Buffer.from(imported.artifact.bytes()), bytes);
      const unit = imported.messages[0]?.sourceUnit;
      assert.ok(unit);
      assert.deepEqual(
        Buffer.from(resolveSourceUnit(imported.artifact, unit)),
        Buffer.from(line),
      );
      assert.equal(unit.startByte, Buffer.byteLength(header + newline));
      assert.equal(unit.endByte, unit.startByte + Buffer.byteLength(line));
      const escapedStart = bytes.indexOf('\\u0061');
      const span = createSourceSpan(
        imported.artifact,
        unit,
        escapedStart,
        escapedStart + 6,
      );
      assert.equal(
        Buffer.from(
          resolveSourceSpan(imported.artifact, unit, span),
        ).toString(),
        '\\u0061',
      );
      assert.equal(imported.messages[0]?.content, 'café 🌱 \n a "quoted"');
    });
  }
}

test('equal decoded meaning does not collapse distinct original artifacts', () => {
  const first = importConversation(
    Buffer.from(`${header}\n{"role":"user","content":"a"}`),
  );
  const second = importConversation(
    Buffer.from(`${header}\n{"role":"user","content":"\\u0061"}\n`),
  );
  assert.equal(first.messages[0]?.content, second.messages[0]?.content);
  assert.notEqual(first.artifact.id, second.artifact.id);
});

test('imported messages and their source references cannot be mutated', () => {
  const input = Buffer.from(`${header}\n${message}\n`);
  const imported = importConversation(input);
  const original = Buffer.from(input);
  input.fill(0);
  assert.deepEqual(Buffer.from(imported.artifact.bytes()), original);
  assert.equal(Object.isFrozen(imported), true);
  assert.equal(Object.isFrozen(imported.messages), true);
  assert.equal(Object.isFrozen(imported.messages[0]), true);
});

const invalidInputs: readonly [string, Uint8Array][] = [
  ['empty input', Buffer.alloc(0)],
  ['invalid JSON', Buffer.from(`${header}\n{`)],
  ['trailing JSON', Buffer.from(`${header}\n${message} {}`)],
  [
    'invalid UTF-8',
    Buffer.concat([Buffer.from(`${header}\n`), Buffer.from([0xff])]),
  ],
  ['BOM', Buffer.from(`\uFEFF${header}\n${message}`)],
  [
    'unsupported format',
    Buffer.from(`{"format":"sulai.conversation.v2"}\n${message}`),
  ],
  [
    'unknown header fields',
    Buffer.from(`{"format":"${CONVERSATION_FORMAT}","extra":1}\n${message}`),
  ],
  ['no messages', Buffer.from(`${header}\n`)],
  ['blank line', Buffer.from(`${header}\n\n${message}`)],
  ['extra blank trailing line', Buffer.from(`${header}\n${message}\n\n`)],
  ['array message', Buffer.from(`${header}\n[]`)],
  ['null message', Buffer.from(`${header}\nnull`)],
  ['unknown role', Buffer.from(`${header}\n{"role":"tool","content":"x"}`)],
  ['missing field', Buffer.from(`${header}\n{"role":"user"}`)],
  [
    'unknown field',
    Buffer.from(`${header}\n{"role":"user","content":"x","approved":true}`),
  ],
  [
    'non-string content',
    Buffer.from(`${header}\n{"role":"user","content":42}`),
  ],
  [
    'unpaired surrogate',
    Buffer.from(`${header}\n{"role":"user","content":"\\ud800"}`),
  ],
  [
    'duplicate field',
    Buffer.from(`${header}\n{"role":"user","role":"assistant","content":"x"}`),
  ],
  [
    'escaped duplicate field',
    Buffer.from(
      `${header}\n{"role":"user","\\u0072ole":"assistant","content":"x"}`,
    ),
  ],
  ['oversize input', Buffer.alloc(MAX_CONVERSATION_BYTES + 1)],
  [
    'too many messages',
    Buffer.from(
      `${header}\n${`${message}\n`.repeat(MAX_CONVERSATION_MESSAGES + 1)}`,
    ),
  ],
];

for (const [name, bytes] of invalidInputs) {
  test(`trust boundary rejects ${name}`, () => {
    assert.throws(() => importConversation(bytes), ValidationError);
  });
}

test('import rejects non-byte values passed by JavaScript callers', () => {
  assert.throws(
    () => importConversation('text' as unknown as Uint8Array),
    ValidationError,
  );
});

test('valid flat records allow escaped keys and empty message content', () => {
  const imported = importConversation(
    Buffer.from(`${header}\n{"\\u0072ole":"assistant","content":""}`),
  );
  assert.equal(imported.messages[0]?.role, 'assistant');
  assert.equal(imported.messages[0]?.content, '');
});

test('the exact byte and message limits are accepted', () => {
  const emptyContent = `${header}\n{"role":"user","content":""}`;
  const padding = 'x'.repeat(
    MAX_CONVERSATION_BYTES - Buffer.byteLength(emptyContent),
  );
  const atByteLimit = Buffer.from(
    `${header}\n${JSON.stringify({ role: 'user', content: padding })}`,
  );
  assert.equal(atByteLimit.length, MAX_CONVERSATION_BYTES);
  assert.equal(
    importConversation(atByteLimit).artifact.byteLength,
    MAX_CONVERSATION_BYTES,
  );
  const atMessageLimit = Buffer.from(
    `${header}\n${`${message}\n`.repeat(MAX_CONVERSATION_MESSAGES)}`,
  );
  assert.equal(
    importConversation(atMessageLimit).messages.length,
    MAX_CONVERSATION_MESSAGES,
  );
});

test('mixed line delimiters preserve every message position', () => {
  const bytes = Buffer.from(
    `${header}\r\n${message}\n${message}\r\n${message}`,
  );
  const imported = importConversation(bytes);
  assert.equal(imported.messages.length, 3);
  for (const item of imported.messages) {
    assert.deepEqual(
      Buffer.from(resolveSourceUnit(imported.artifact, item.sourceUnit)),
      Buffer.from(message),
    );
  }
  assert.deepEqual(Buffer.from(imported.artifact.bytes()), bytes);
});
