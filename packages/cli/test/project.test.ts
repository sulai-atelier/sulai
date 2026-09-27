import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  MAX_CONVERSATION_BYTES,
  importConversation,
  ValidationError,
} from '@sulai/core';
import {
  STREAM_CHUNK_BYTES,
  importArtifactFile,
  initializeProject,
  inspectArtifact,
  inspectProject,
  interpretConversation,
} from '../dist/project.js';

const fixture = fileURLToPath(
  new URL('../../../fixtures/synthetic.conversation.jsonl', import.meta.url),
);
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sulai-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function storedFile(directory: string, id: string) {
  return join(
    directory,
    '.sulai',
    'artifacts',
    `${id.slice('sha256:'.length)}.raw`,
  );
}

async function temporaryEntries(directory: string) {
  try {
    return await readdir(join(directory, '.sulai', 'tmp'));
  } catch {
    return [];
  }
}

test('the project marker is an exact, independently specified byte sequence', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const marker = await readFile(join(directory, '.sulai', 'project.json'));
  // Written out independently of the implementation so a silent format change
  // fails here. The marker describes the storage format only; it deliberately
  // carries no artifact format.
  assert.equal(
    marker.toString('utf8'),
    '{"format":"sulai.project","version":2}\n',
  );
  assert.equal(marker.byteLength, 39);
});

test('initialization and repeated imports are idempotent and preserve bytes exactly', async (t) => {
  const directory = await temporary(t);
  assert.equal((await initializeProject(directory)).created, true);
  const marker = await readFile(join(directory, '.sulai', 'project.json'));
  assert.equal((await initializeProject(directory)).created, false);
  assert.deepEqual(
    await readFile(join(directory, '.sulai', 'project.json')),
    marker,
  );
  const first = await importArtifactFile(directory, fixture);
  const second = await importArtifactFile(directory, fixture);
  assert.equal(first.created, true);
  assert.deepEqual(second, { ...first, created: false });
  assert.deepEqual(
    await readFile(storedFile(directory, first.id)),
    await readFile(fixture),
  );
  assert.equal((await inspectProject(directory)).artifacts.length, 1);
  assert.deepEqual(await temporaryEntries(directory), []);
});

test('storage accepts arbitrary bytes and never interprets them', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const filename = join(directory, 'arbitrary.bin');
  // Not a conversation, not text, not valid UTF-8.
  const raw = Buffer.from([0x00, 0xff, 0xfe, 0x50, 0x4b, 0x03, 0x04, 0x80]);
  await writeFile(filename, raw);
  const imported = await importArtifactFile(directory, filename);
  assert.equal(imported.created, true);
  assert.equal(imported.byteLength, raw.byteLength);
  assert.deepEqual(await readFile(storedFile(directory, imported.id)), raw);
  // Generic inspection proves integrity without any format knowledge.
  const inspection = await inspectProject(directory);
  assert.deepEqual(inspection.artifacts, [
    { id: imported.id, byteLength: raw.byteLength },
  ]);
  assert.equal(inspection.version, 2);
});

test('preserve first, interpret second: unreadable material is stored and survives a failed interpretation', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const filename = join(directory, 'not-a-conversation.jsonl');
  const raw = Buffer.from('this is not the synthetic conversation format');
  await writeFile(filename, raw);
  // Import succeeds: preservation does not depend on understanding.
  const imported = await importArtifactFile(directory, filename);
  assert.equal(imported.created, true);
  // Interpretation fails, because today's only reader cannot read it.
  await assert.rejects(
    interpretConversation(directory, imported.id),
    ValidationError,
  );
  // The bytes are untouched, so a better reader later can re-derive from them
  // without the user importing again.
  assert.deepEqual(await readFile(storedFile(directory, imported.id)), raw);
  assert.deepEqual((await inspectProject(directory)).artifacts, [
    { id: imported.id, byteLength: raw.byteLength },
  ]);
});

test('interpretation reconstructs messages and source references after relocation', async (t) => {
  const directory = await temporary(t);
  const originalProject = join(directory, 'original');
  const relocatedProject = join(directory, 'relocated');
  await initializeProject(originalProject);
  const imported = await importArtifactFile(originalProject, fixture);
  const expected = await interpretConversation(originalProject, imported.id);
  await rename(originalProject, relocatedProject);
  assert.deepEqual(
    await interpretConversation(relocatedProject, imported.id),
    expected,
  );
  assert.equal(expected.messageCount, 3);
  assert.equal(expected.messages.length, 3);
  const raw = await readFile(fixture);
  for (const message of expected.messages) {
    assert.equal(
      message.rawSource,
      raw
        .subarray(message.sourceUnit.startByte, message.sourceUnit.endByte)
        .toString('utf8'),
    );
    assert.equal(message.sourceUnit.artifactId, imported.id);
  }
});

test('generic inspection reports identity and size without interpreting', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const imported = await importArtifactFile(directory, fixture);
  const inspected = await inspectArtifact(directory, imported.id);
  assert.deepEqual(inspected, {
    id: imported.id,
    byteLength: imported.byteLength,
  });
  assert.equal(Object.hasOwn(inspected, 'messages'), false);
  assert.equal(Object.hasOwn(inspected, 'format'), false);
});

test('an absent temporary directory does not invalidate a project', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  // `.sulai/tmp` is ephemeral and re-created on demand.
  await rm(join(directory, '.sulai', 'tmp'), { recursive: true });
  assert.deepEqual((await inspectProject(directory)).artifacts, []);
  const imported = await importArtifactFile(directory, fixture);
  assert.equal(imported.created, true);
  assert.deepEqual(await temporaryEntries(directory), []);
});

test('concurrent identical imports publish one complete artifact', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => importArtifactFile(directory, fixture)),
  );
  assert.equal(results.filter((result) => result.created).length, 1);
  const inspection = await inspectProject(directory);
  assert.equal(inspection.artifacts.length, 1);
  assert.deepEqual(await temporaryEntries(directory), []);
});

test('every transient lock class is retried after publishing complete bytes', async (t) => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const directory = await temporary(t);
    await initializeProject(directory);
    const originalUnlink = fs.unlink;
    let attempts = 0;
    const mockedUnlink = t.mock.method(
      fs,
      'unlink',
      async (filename: Parameters<typeof fs.unlink>[0]) => {
        attempts += 1;
        if (attempts <= 2)
          throw Object.assign(new Error('Synthetic temporary lock'), { code });
        return originalUnlink(filename);
      },
    );
    syncBuiltinESMExports();
    const imported = await importArtifactFile(directory, fixture);
    mockedUnlink.mock.restore();
    syncBuiltinESMExports();
    assert.equal(imported.created, true, code);
    assert.equal(attempts, 3, code);
    assert.deepEqual(
      await readFile(storedFile(directory, imported.id)),
      await readFile(fixture),
    );
  }
});

test('an already-removed temporary file is not an error', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const originalUnlink = fs.unlink;
  let sawEnoent = false;
  const mockedUnlink = t.mock.method(
    fs,
    'unlink',
    async (filename: Parameters<typeof fs.unlink>[0]) => {
      await originalUnlink(filename);
      sawEnoent = true;
      // A second removal of the same path is what a racing cleaner would cause.
      return originalUnlink(filename);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mockedUnlink.mock.restore();
    syncBuiltinESMExports();
  });
  const imported = await importArtifactFile(directory, fixture);
  assert.equal(imported.created, true);
  assert.equal(sawEnoent, true);
});

test('persistent temporary-file locks fail after bounded retries without losing the artifact', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  let attempts = 0;
  const mockedUnlink = t.mock.method(fs, 'unlink', async () => {
    attempts += 1;
    throw Object.assign(new Error('Synthetic persistent lock'), {
      code: 'EBUSY',
    });
  });
  syncBuiltinESMExports();
  t.after(() => {
    mockedUnlink.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(importArtifactFile(directory, fixture), {
    code: 'EBUSY',
  });
  assert.equal(attempts, 4);
  const artifact = importConversation(await readFile(fixture)).artifact;
  assert.deepEqual(
    await readFile(storedFile(directory, artifact.id)),
    await readFile(fixture),
  );
  assert.equal((await inspectProject(directory)).artifacts.length, 1);
});

test('publication and cleanup failures retain both errors', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const publicationError = Object.assign(
    new Error('Synthetic publication failure'),
    { code: 'ENOSPC' },
  );
  const cleanupError = Object.assign(new Error('Synthetic cleanup failure'), {
    code: 'EROFS',
  });
  const mockedLink = t.mock.method(fs, 'link', async () => {
    throw publicationError;
  });
  const mockedUnlink = t.mock.method(fs, 'unlink', async () => {
    throw cleanupError;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mockedLink.mock.restore();
    mockedUnlink.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    importArtifactFile(directory, fixture),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [publicationError, cleanupError]);
      assert.equal(error.cause, publicationError);
      return true;
    },
  );
  assert.deepEqual((await inspectProject(directory)).artifacts, []);
});

test('the filesystem round trip preserves CRLF, whitespace, Unicode, and no final newline', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const raw = Buffer.from(
    '{"format":"sulai.conversation.v1"}\r\n  { "role": "user", "content": "🌱 café \\u0061" }  ',
  );
  const filename = join(directory, 'synthetic.jsonl');
  await writeFile(filename, raw);
  const imported = await importArtifactFile(directory, filename);
  assert.deepEqual(await readFile(storedFile(directory, imported.id)), raw);
});

test('an artifact larger than the former 64 MiB ceiling is preserved by streaming', async (t) => {
  // The 64 MiB buffered ceiling was removed because real AI session history
  // already exceeds it. This writes the file and computes its identity
  // independently, a block at a time, so neither side holds it in memory.
  const directory = await temporary(t);
  await initializeProject(directory);
  const filename = join(directory, 'large.bin');
  const block = Buffer.alloc(1024 * 1024, 0x5a);
  const blocks = 64;
  const expected = createHash('sha256');
  const handle = await fs.open(filename, 'w');
  try {
    for (let index = 0; index < blocks; index += 1) {
      await handle.write(block);
      expected.update(block);
    }
    const tail = Buffer.from([0x01]);
    await handle.write(tail);
    expected.update(tail);
  } finally {
    await handle.close();
  }
  const byteLength = blocks * block.byteLength + 1;
  const id = `sha256:${expected.digest('hex')}`;

  const imported = await importArtifactFile(directory, filename);
  assert.deepEqual(imported, { id, byteLength, created: true });
  assert.equal((await stat(storedFile(directory, id))).size, byteLength);
  // Verification streams too, so inspecting it succeeds without loading it.
  assert.deepEqual((await inspectProject(directory)).artifacts, [
    { id, byteLength },
  ]);
  assert.deepEqual(await inspectArtifact(directory, id), { id, byteLength });
  assert.deepEqual(await temporaryEntries(directory), []);
});

test('streaming preserves exact bytes and identity across chunk boundaries', async (t) => {
  // Content that differs at every offset, several chunks long with a ragged
  // final chunk, so an off-by-one at a boundary changes the hash.
  const directory = await temporary(t);
  await initializeProject(directory);
  const length = STREAM_CHUNK_BYTES * 3 + 12345;
  const raw = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    raw[index] = (index * 31 + (index >>> 8)) & 0xff;
  }
  const filename = join(directory, 'ragged.bin');
  await writeFile(filename, raw);
  const imported = await importArtifactFile(directory, filename);
  assert.equal(
    imported.id,
    `sha256:${createHash('sha256').update(raw).digest('hex')}`,
  );
  assert.equal(imported.byteLength, length);
  assert.deepEqual(await readFile(storedFile(directory, imported.id)), raw);
});

test('an empty file is preserved as the empty artifact', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const filename = join(directory, 'empty.bin');
  await writeFile(filename, Buffer.alloc(0));
  const imported = await importArtifactFile(directory, filename);
  assert.deepEqual(imported, {
    id: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    byteLength: 0,
    created: true,
  });
  assert.equal((await inspectProject(directory)).artifacts.length, 1);
});

test('directories are refused and leave no artifact or temporary files', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  await assert.rejects(
    importArtifactFile(directory, directory),
    ValidationError,
  );
  assert.deepEqual((await inspectProject(directory)).artifacts, []);
  assert.deepEqual(await temporaryEntries(directory), []);
});

test('interpretation refuses an artifact too large for its format without reading it', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const filename = join(directory, 'too-large.jsonl');
  await writeFile(filename, Buffer.alloc(MAX_CONVERSATION_BYTES + 1, 0x20));
  // Storage accepts it: there is no storage ceiling.
  const imported = await importArtifactFile(directory, filename);
  assert.equal(imported.byteLength, MAX_CONVERSATION_BYTES + 1);
  await assert.rejects(
    interpretConversation(directory, imported.id),
    /this format accepts at most/,
  );
  // Refusing to interpret it does not affect what was preserved.
  assert.deepEqual(await inspectArtifact(directory, imported.id), {
    id: imported.id,
    byteLength: MAX_CONVERSATION_BYTES + 1,
  });
});

test('corruption is detected and re-import never replaces the damaged file', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const imported = await importArtifactFile(directory, fixture);
  const damaged = Buffer.from('different synthetic content');
  const destination = storedFile(directory, imported.id);
  await writeFile(destination, damaged);
  await assert.rejects(
    inspectArtifact(directory, imported.id),
    /hash does not match/,
  );
  await assert.rejects(inspectProject(directory), /hash does not match/);
  await assert.rejects(
    importArtifactFile(directory, fixture),
    /refusing to overwrite/,
  );
  assert.deepEqual(await readFile(destination), damaged);
  assert.deepEqual(await temporaryEntries(directory), []);
});

test('same-length corruption is detected, because integrity is a hash, not a size', async (t) => {
  // The size check in the read path only guards against a file changing while
  // it is being read. Integrity itself is the content hash, so flipping one
  // byte without changing the length must still be caught.
  const directory = await temporary(t);
  await initializeProject(directory);
  const imported = await importArtifactFile(directory, fixture);
  const destination = storedFile(directory, imported.id);
  const flipped = await readFile(destination);
  flipped[10] = flipped[10] === 0x41 ? 0x42 : 0x41;
  await writeFile(destination, flipped);
  assert.equal((await stat(destination)).size, imported.byteLength);
  await assert.rejects(
    inspectArtifact(directory, imported.id),
    /hash does not match/,
  );
  await assert.rejects(
    importArtifactFile(directory, fixture),
    /refusing to overwrite/,
  );
  assert.deepEqual(await readFile(destination), flipped);
});

test('invalid IDs, metadata, and unexpected store entries are rejected', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  await assert.rejects(
    inspectArtifact(directory, '../project.json'),
    ValidationError,
  );
  const unknown = join(directory, '.sulai', 'artifacts', 'unknown');
  await writeFile(unknown, 'synthetic');
  await assert.rejects(inspectProject(directory), /Unexpected entry/);
  await rm(unknown);
  const marker = join(directory, '.sulai', 'project.json');
  await writeFile(marker, '{"format":"sulai.project","version":999}');
  await assert.rejects(inspectProject(directory), /storage format version 999/);
  await assert.rejects(initializeProject(directory), ValidationError);
  assert.equal(
    await readFile(marker, 'utf8'),
    '{"format":"sulai.project","version":999}',
  );
  await writeFile(marker, 'not json at all');
  await assert.rejects(
    inspectProject(directory),
    /unsupported project metadata/,
  );
});

test('a version 1 project is refused with a specific, actionable message', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const marker = join(directory, '.sulai', 'project.json');
  // Exactly what version 1 wrote, including the artifact format it embedded.
  await writeFile(
    marker,
    '{"format":"sulai.project","version":1,"artifactFormat":"sulai.conversation.v1"}\n',
  );
  const specific =
    /storage format version 1.*requires version 2.*does not migrate/s;
  await assert.rejects(inspectProject(directory), specific);
  // Every entry point must name the version. `init` previously reached the
  // publish path first and reported a byte-count mismatch, which tells the user
  // nothing about why their project is refused.
  await assert.rejects(initializeProject(directory), specific);
  await assert.rejects(importArtifactFile(directory, fixture), specific);
  await assert.rejects(
    interpretConversation(directory, 'sha256:' + 'a'.repeat(64)),
    specific,
  );
  const result = spawnSync(process.execPath, [cli, 'init', directory], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, specific);
  // The incompatible marker is never overwritten.
  assert.equal(
    await readFile(marker, 'utf8'),
    '{"format":"sulai.project","version":1,"artifactFormat":"sulai.conversation.v1"}\n',
  );
});

test('a file that changes size while being read is refused rather than hashed', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const filename = join(directory, 'growing.bin');
  await writeFile(filename, Buffer.alloc(64, 1));
  const originalOpen = fs.open;
  // Report a smaller size than the file really has, which is what a stat taken
  // before a concurrent append looks like. Only this file is affected, so the
  // project marker still reads normally.
  const mocked = t.mock.method(
    fs,
    'open',
    async (path: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
      const handle = await (
        originalOpen as (
          ...a: unknown[]
        ) => Promise<Awaited<ReturnType<typeof fs.open>>>
      )(path, ...rest);
      if (String(path) !== filename) return handle;
      const originalStat = handle.stat.bind(handle);
      // `stat` is overloaded, so replace it through an unknown-typed view
      // rather than trying to satisfy every overload in a test double.
      (handle as unknown as { stat: () => Promise<unknown> }).stat =
        async () => {
          const observed = await originalStat();
          return Object.create(observed, {
            size: { value: observed.size - 1 },
          }) as unknown;
        };
      return handle;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    importArtifactFile(directory, filename),
    /changed size while it was being read/,
  );
  // Nothing was stored from the torn read, and the partially written staging
  // file was removed. Streaming fails mid-copy, after bytes were written.
  assert.deepEqual((await inspectProject(directory)).artifacts, []);
  assert.deepEqual(await temporaryEntries(directory), []);
});

test('import requires initialization and does not implicitly create storage', async (t) => {
  const directory = await temporary(t);
  await assert.rejects(importArtifactFile(directory, fixture), {
    code: 'ENOENT',
  });
  assert.deepEqual(await readdir(directory), []);
});

test('storage directories cannot be redirected through symbolic links or junctions', async (t) => {
  const directory = await temporary(t);
  const outside = join(directory, 'outside');
  const project = join(directory, 'project');
  await initializeProject(outside);
  await initializeProject(project);
  const artifacts = join(project, '.sulai', 'artifacts');
  await rm(artifacts, { recursive: true });
  await symlink(
    join(outside, '.sulai', 'artifacts'),
    artifacts,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    importArtifactFile(project, fixture),
    /regular directories/,
  );
  assert.deepEqual((await inspectProject(outside)).artifacts, []);
});

test('CLI initializes, imports, inspects, and interprets in separate processes', async (t) => {
  const directory = join(await temporary(t), 'project with spaces');
  function run(args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout) as unknown;
  }
  assert.deepEqual(run(['init', directory]), { directory, created: true });
  const artifact = importConversation(await readFile(fixture)).artifact;
  const summary = { id: artifact.id, byteLength: artifact.byteLength };
  assert.deepEqual(run(['import', directory, fixture]), {
    ...summary,
    created: true,
  });
  assert.deepEqual(run(['inspect', directory]), {
    format: 'sulai.project',
    version: 2,
    artifacts: [summary],
  });
  assert.deepEqual(run(['inspect', directory, artifact.id]), summary);
  assert.deepEqual(
    run(['interpret', directory, artifact.id]),
    JSON.parse(
      JSON.stringify(await interpretConversation(directory, artifact.id)),
    ) as unknown,
  );
});

test('CLI help and invalid arguments have deliberate exit status and output', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
  });
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  for (const args of [
    ['unknown'],
    ['init'],
    ['import', 'directory'],
    ['inspect', '.', 'id', 'extra'],
    ['interpret', 'directory'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /sulai: Usage:/);
  }
});

test('CLI rejects unreadable interpretation without echoing source content', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const filename = join(directory, 'invalid.jsonl');
  await writeFile(filename, 'SYNTHETIC_PRIVATE_MARKER');
  // Import now succeeds, because preservation does not require understanding.
  const imported = await importArtifactFile(directory, filename);
  const result = spawnSync(
    process.execPath,
    [cli, 'interpret', directory, imported.id],
    { encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /SYNTHETIC_PRIVATE_MARKER/);
  // The artifact is still there and still exact.
  assert.equal((await inspectProject(directory)).artifacts.length, 1);
});

test('the experimental Claude Code command reports structure and never message text', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const session = fileURLToPath(
    new URL(
      '../../../fixtures/synthetic.claude-code-session.jsonl',
      import.meta.url,
    ),
  );
  const imported = await importArtifactFile(directory, session);
  const result = spawnSync(
    process.execPath,
    [cli, 'experimental', 'claude-code-session', directory, imported.id],
    { encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const reading = JSON.parse(result.stdout) as {
    recordCount: number;
    kinds: Record<string, number>;
    unknownTypes: string[];
  };
  assert.equal(reading.recordCount, 14);
  assert.deepEqual(reading.kinds, {
    metadata: 2,
    message: 10,
    unknown: 1,
    unparseable: 1,
  });
  assert.deepEqual(reading.unknownTypes, ['synthetic-future-record']);
  assert.doesNotMatch(result.stdout, /Synthetic (request|reasoning|file body)/);
});
