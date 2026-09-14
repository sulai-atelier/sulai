import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
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
  importConversationFile,
  initializeProject,
  inspectArtifact,
  inspectProject,
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

test('initialization and repeated imports are idempotent and preserve bytes exactly', async (t) => {
  const directory = await temporary(t);
  assert.equal((await initializeProject(directory)).created, true);
  const marker = await readFile(join(directory, '.sulai', 'project.json'));
  assert.equal((await initializeProject(directory)).created, false);
  assert.deepEqual(
    await readFile(join(directory, '.sulai', 'project.json')),
    marker,
  );
  const first = await importConversationFile(directory, fixture);
  const second = await importConversationFile(directory, fixture);
  assert.equal(first.created, true);
  assert.deepEqual(second, { ...first, created: false });
  assert.deepEqual(
    await readFile(storedFile(directory, first.id)),
    await readFile(fixture),
  );
  assert.equal((await inspectProject(directory)).artifacts.length, 1);
  assert.deepEqual(await readdir(join(directory, '.sulai', 'tmp')), []);
});

test('concurrent identical imports publish one complete artifact', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => importConversationFile(directory, fixture)),
  );
  assert.equal(results.filter((result) => result.created).length, 1);
  const inspection = await inspectProject(directory);
  assert.equal(inspection.artifacts.length, 1);
  assert.deepEqual(await readdir(join(directory, '.sulai', 'tmp')), []);
});

test('transient temporary-file locks are retried after publishing complete bytes', async (t) => {
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
        throw Object.assign(new Error('Synthetic temporary lock'), {
          code: 'EBUSY',
        });
      return originalUnlink(filename);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mockedUnlink.mock.restore();
    syncBuiltinESMExports();
  });
  const imported = await importConversationFile(directory, fixture);
  assert.equal(imported.created, true);
  assert.equal(attempts, 3);
  assert.deepEqual(
    await readFile(storedFile(directory, imported.id)),
    await readFile(fixture),
  );
  assert.deepEqual(await readdir(join(directory, '.sulai', 'tmp')), []);
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
  await assert.rejects(importConversationFile(directory, fixture), {
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
    { code: 'EACCES' },
  );
  const cleanupError = Object.assign(new Error('Synthetic cleanup failure'), {
    code: 'EPERM',
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
    importConversationFile(directory, fixture),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [publicationError, cleanupError]);
      assert.equal(error.cause, publicationError);
      return true;
    },
  );
  assert.deepEqual((await inspectProject(directory)).artifacts, []);
});

test('inspection reconstructs messages and source references after relocation', async (t) => {
  const directory = await temporary(t);
  const originalProject = join(directory, 'original');
  const relocatedProject = join(directory, 'relocated');
  await initializeProject(originalProject);
  const imported = await importConversationFile(originalProject, fixture);
  const expected = await inspectArtifact(originalProject, imported.id);
  await rename(originalProject, relocatedProject);
  assert.deepEqual(
    await inspectArtifact(relocatedProject, imported.id),
    expected,
  );
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

test('the filesystem round trip preserves CRLF, whitespace, Unicode, and no final newline', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const raw = Buffer.from(
    '{"format":"sulai.conversation.v1"}\r\n  { "role": "user", "content": "🌱 café \\u0061" }  ',
  );
  const filename = join(directory, 'synthetic.jsonl');
  await writeFile(filename, raw);
  const imported = await importConversationFile(directory, filename);
  assert.deepEqual(await readFile(storedFile(directory, imported.id)), raw);
});

test('malformed and oversized external files leave no artifact or temporary files', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const filename = join(directory, 'invalid.jsonl');
  for (const bytes of [
    Buffer.from('not JSON'),
    Buffer.alloc(MAX_CONVERSATION_BYTES + 1),
  ]) {
    await writeFile(filename, bytes);
    await assert.rejects(
      importConversationFile(directory, filename),
      ValidationError,
    );
    assert.deepEqual((await inspectProject(directory)).artifacts, []);
    assert.deepEqual(await readdir(join(directory, '.sulai', 'tmp')), []);
  }
  await assert.rejects(
    importConversationFile(directory, directory),
    ValidationError,
  );
});

test('corruption is detected and re-import never replaces the damaged file', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const imported = await importConversationFile(directory, fixture);
  const damaged = Buffer.from(
    '{"format":"sulai.conversation.v1"}\n{"role":"user","content":"different synthetic content"}\n',
  );
  const destination = storedFile(directory, imported.id);
  await writeFile(destination, damaged);
  await assert.rejects(
    inspectArtifact(directory, imported.id),
    /hash does not match/,
  );
  await assert.rejects(inspectProject(directory), /hash does not match/);
  await assert.rejects(
    importConversationFile(directory, fixture),
    /refusing to overwrite/,
  );
  assert.deepEqual(await readFile(destination), damaged);
  assert.deepEqual(await readdir(join(directory, '.sulai', 'tmp')), []);
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
  const marker = join(directory, '.sulai', 'project.json');
  await writeFile(marker, '{"format":"sulai.project","version":999}');
  await assert.rejects(
    inspectProject(directory),
    /unsupported project metadata/,
  );
  await assert.rejects(initializeProject(directory), ValidationError);
  assert.equal(
    await readFile(marker, 'utf8'),
    '{"format":"sulai.project","version":999}',
  );
});

test('import requires initialization and does not implicitly create storage', async (t) => {
  const directory = await temporary(t);
  await assert.rejects(importConversationFile(directory, fixture), {
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
    importConversationFile(project, fixture),
    /regular directories/,
  );
  assert.deepEqual((await inspectProject(outside)).artifacts, []);
});

test('CLI initializes, imports, lists, and inspects the synthetic fixture in separate processes', async (t) => {
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
  const summary = {
    id: artifact.id,
    byteLength: artifact.byteLength,
    messageCount: 3,
  };
  assert.deepEqual(run(['import', directory, fixture]), {
    ...summary,
    created: true,
  });
  assert.deepEqual(run(['inspect', directory]), { artifacts: [summary] });
  assert.deepEqual(
    run(['inspect', directory, artifact.id]),
    await inspectArtifact(directory, artifact.id),
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

test('CLI rejects invalid imports without echoing source content', async (t) => {
  const directory = await temporary(t);
  await initializeProject(directory);
  const filename = join(directory, 'invalid.jsonl');
  await writeFile(filename, 'SYNTHETIC_PRIVATE_MARKER');
  const result = spawnSync(
    process.execPath,
    [cli, 'import', directory, filename],
    { encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /SYNTHETIC_PRIVATE_MARKER/);
  assert.deepEqual((await inspectProject(directory)).artifacts, []);
});
