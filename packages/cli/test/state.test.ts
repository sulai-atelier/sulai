import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { encodeStateRevision, hashContent } from '@sulai/core';
import type { StateId } from '@sulai/core';
import {
  MAX_WHY_BYTES,
  diffStates,
  explainLine,
  importPaths,
  initializeProject,
  inspectProject,
  inspectState,
  projectStatus,
  recordState,
} from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sulai-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const EVIDENCE: Record<string, string | Buffer> = {
  'lf.md': 'a\nbb\nccc\n',
  'crlf.md': 'a\r\nbb\r\n',
  'nofinal.md': 'x\ny',
  'empty-line.md': 'a\n\nb\n',
  'bin.dat': Buffer.from([0x61, 0x0a, 0xff, 0xfe, 0x0a]),
  'bom.md': '\ufeffhead\n',
};

/** r1 holds the project (so its store is excluded) and the evidence; r2 is one file. */
async function setup(t: TestContext) {
  const base = await temporary(t);
  const directory = join(base, 'project');
  await initializeProject(directory);
  await mkdir(join(base, 'evidence'));
  for (const [name, content] of Object.entries(EVIDENCE)) {
    await writeFile(join(base, 'evidence', name), content);
  }
  const elsewhere = await temporary(t);
  const single = join(elsewhere, 'single.txt');
  await writeFile(single, 'one\ntwo\n');
  const { occurrenceId } = await importPaths(directory, [base, single]);
  return { base, directory, occurrenceId, elsewhere };
}

async function page(dir: string, name: string, text: string | Buffer) {
  const file = join(dir, name);
  await writeFile(file, text);
  return file;
}

function mockOnce(
  t: TestContext,
  name: 'link',
  implementation: (...args: never[]) => unknown,
) {
  const mocked = t.mock.method(fs, name, implementation as never);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}

test('references resolve to exact bytes by the line rules, or stay unresolved with a reason', async (t) => {
  const { directory, occurrenceId, elsewhere } = await setup(t);
  const cited: Record<string, [string, number, number] | string> = {
    'r1/evidence/lf.md#L2': ['bb', 2, 4],
    'r1/evidence/lf.md#L2-L3': ['bb\nccc', 2, 8],
    'r1/evidence/crlf.md#L2': ['bb', 3, 5],
    'r1/evidence/crlf.md#L1-L2': ['a\r\nbb', 0, 5],
    'r1/evidence/nofinal.md#L2': ['y', 2, 3],
    'r1/evidence/empty-line.md#L2': ['', 2, 2],
    'r1/evidence/bin.dat#L1': ['a', 0, 1],
    'r2#L2': ['two', 4, 7],
    'r1/evidence/bom.md#L1': ['\ufeffhead', 0, 7],
    'r1/evidence/bin.dat#L2': 'not-utf8-text',
    'r1/evidence/lf.md#L4': 'line-out-of-range',
    'r1/evidence/lf.md#L0': 'invalid-lines',
    'r1/evidence/lf.md#L3-L2': 'invalid-lines',
    'r9/evidence/lf.md#L1': 'unknown-root',
    'r1/evidence/missing.md#L1': 'path-not-in-occurrence',
    'r1#L1': 'path-not-in-occurrence',
    'r2/single.txt#L1': 'path-not-in-occurrence',
    'r1/project/.sulai/project.json#L1': 'not-captured',
  };
  const text =
    Object.keys(cited)
      .map((locator, index) => `- claim ${index} \`${locator}\``)
      .join('\n') + '\n';
  const recorded = await recordState(
    directory,
    await page(elsewhere, 'STATE.md', text),
    occurrenceId,
  );
  assert.equal(recorded.parent, null);
  assert.equal(recorded.references.total, 18);
  assert.equal(recorded.references.resolved, 9);
  const revision = await inspectState(directory, recorded.id);
  assert.deepEqual(
    revision.references.map((r) => r.locator),
    Object.keys(cited),
  );
  for (const reference of revision.references) {
    const expected = cited[reference.locator];
    assert.ok(expected !== undefined, reference.locator);
    if (typeof expected === 'string') {
      assert.deepEqual(
        reference,
        { locator: reference.locator, status: 'unresolved', reason: expected },
        reference.locator,
      );
    } else {
      assert.equal(reference.status, 'resolved', reference.locator);
      if (reference.status !== 'resolved') continue;
      assert.deepEqual(
        [reference.startByte, reference.endByte],
        [expected[1], expected[2]],
        reference.locator,
      );
    }
  }
  // why returns exactly those bytes, line by line.
  const lines = Object.keys(cited);
  for (let index = 0; index < lines.length; index += 1) {
    const explained = await explainLine(directory, recorded.id, index + 1);
    const [reference] = explained.references;
    const expected = cited[lines[index] as string];
    assert.ok(expected !== undefined);
    if (typeof expected === 'string') {
      assert.equal(reference?.status, 'unresolved');
    } else {
      assert.equal(
        (reference as { evidence: string }).evidence,
        expected[0],
        lines[index],
      );
    }
  }
  await assert.rejects(
    explainLine(directory, recorded.id, 99),
    /The page has 18 lines/,
  );
});

test('the parent is the one head, several heads are never chosen between, and status shows them all', async (t) => {
  const { directory, occurrenceId, elsewhere } = await setup(t);
  const first = await recordState(
    directory,
    await page(elsewhere, 'a.md', 'one `r2#L1`\n'),
    occurrenceId,
  );
  const second = await recordState(
    directory,
    await page(elsewhere, 'b.md', 'two `r2#L2`\n'),
    occurrenceId,
  );
  assert.equal(first.parent, null);
  assert.equal(second.parent, first.id);
  const branch = await recordState(
    directory,
    await page(elsewhere, 'c.md', 'three\n'),
    occurrenceId,
    first.id,
  );
  assert.equal(branch.parent, first.id);
  const status = await projectStatus(directory);
  assert.deepEqual(
    status.heads.map((head) => head.id).sort(),
    [second.id, branch.id].sort(),
  );
  assert.deepEqual(status.heads.map((head) => head.page).sort(), [
    'three\n',
    'two `r2#L2`\n',
  ]);
  await assert.rejects(
    recordState(
      directory,
      await page(elsewhere, 'd.md', 'four\n'),
      occurrenceId,
    ),
    /There are 2 heads; name the parent with --parent/,
  );
  const extended = await recordState(
    directory,
    await page(elsewhere, 'd.md', 'four\n'),
    occurrenceId,
    second.id,
  );
  assert.equal(extended.parent, second.id);
  await assert.rejects(
    recordState(
      directory,
      await page(elsewhere, 'e.md', 'x\n'),
      occurrenceId,
      `state:v1:${'a'.repeat(64)}`,
    ),
    /parent state is not stored/,
  );
  // One parent per revision: extending one head leaves the fork open.
  const after = await projectStatus(directory);
  assert.deepEqual(
    after.heads.map((head) => head.id).sort(),
    [branch.id, extended.id].sort(),
  );
  await assert.rejects(
    recordState(directory, await page(elsewhere, 'e.md', 'x\n'), occurrenceId),
    /There are 2 heads/,
  );
});

test('status hashes every revision and each head page, never the cited evidence', async (t) => {
  const { directory, occurrenceId, elsewhere } = await setup(t);
  const headPage = 'b `r1/evidence/lf.md#L3`\n';
  const first = await recordState(
    directory,
    await page(elsewhere, 'a.md', 'a `r1/evidence/lf.md#L2`\n'),
    occurrenceId,
  );
  const head = await recordState(
    directory,
    await page(elsewhere, 'b.md', headPage),
    occurrenceId,
  );
  const store = join(directory, '.sulai');
  const artifact = (content: string) =>
    join(
      store,
      'artifacts',
      `${hashContent(Buffer.from(content)).slice(7)}.raw`,
    );
  async function corrupted(path: string, check: () => Promise<unknown>) {
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from(' ')]));
    await check();
    await writeFile(path, original);
  }
  await corrupted(artifact(EVIDENCE['lf.md'] as string), async () => {
    const status = await projectStatus(directory);
    assert.deepEqual(
      status.heads.map((item) => item.id),
      [head.id],
    );
    await assert.rejects(
      explainLine(directory, head.id, 1),
      /hash does not match/,
    );
  });
  await corrupted(artifact(headPage), () =>
    assert.rejects(projectStatus(directory), /hash does not match/),
  );
  await corrupted(
    join(store, 'states', `${first.id.slice('state:v1:'.length)}.json`),
    () => assert.rejects(projectStatus(directory), /hash does not match/),
  );
});

test('diff lists the lines removed and added, in order, and nothing else', async (t) => {
  const { directory, occurrenceId, elsewhere } = await setup(t);
  const a = await recordState(
    directory,
    await page(elsewhere, 'a.md', 'keep\nold `r2#L1`\nsame\n'),
    occurrenceId,
  );
  const b = await recordState(
    directory,
    await page(elsewhere, 'b.md', 'keep\nsame\nnew `r2#L2`\n'),
    occurrenceId,
  );
  assert.deepEqual((await diffStates(directory, a.id, b.id)).changes, [
    { op: '-', line: 'old `r2#L1`' },
    { op: '+', line: 'new `r2#L2`' },
  ]);
  assert.deepEqual((await diffStates(directory, a.id, a.id)).changes, []);
});

test('why verifies the cited artifact first and reads a bounded range', async (t) => {
  const base = await temporary(t);
  const directory = join(base, 'project');
  await initializeProject(directory);
  const evidence = join(base, 'evidence');
  await mkdir(evidence);
  // Two-byte characters, so the cut can land inside one.
  const line = `${'é'.repeat(500)}\n`;
  await writeFile(join(evidence, 'big.txt'), line.repeat(1500));
  const { occurrenceId } = await importPaths(directory, [evidence]);
  const recorded = await recordState(
    directory,
    await page(base, 'p.md', 'big `r1/big.txt#L1-L1500`\n'),
    occurrenceId,
  );
  const explained = await explainLine(directory, recorded.id, 1);
  const [reference] = explained.references as {
    truncated: boolean;
    evidence: string;
  }[];
  assert.equal(reference?.truncated, true);
  assert.ok(Buffer.byteLength(reference?.evidence ?? '') <= MAX_WHY_BYTES);
  assert.doesNotMatch(reference?.evidence ?? '', /\ufffd/);

  const revision = await inspectState(directory, recorded.id);
  const cited = revision.references[0];
  assert.ok(cited && cited.status === 'resolved');
  const file = join(
    directory,
    '.sulai',
    'artifacts',
    `${cited.artifact.slice(7)}.raw`,
  );
  const bytes = await readFile(file);
  bytes[5] = 0x79;
  await writeFile(file, bytes);
  await assert.rejects(
    explainLine(directory, recorded.id, 1),
    /hash does not match/,
  );
});

/** Counts how many times anything computes each hex SHA-256 digest from now on. */
function countDigests(t: TestContext) {
  const counts = new Map<string, number>();
  const original = crypto.createHash;
  const mocked = t.mock.method(crypto, 'createHash', ((
    ...args: Parameters<typeof crypto.createHash>
  ) => {
    const hash = original(...args);
    const digest = hash.digest.bind(hash) as (encoding?: 'hex') => unknown;
    hash.digest = ((encoding?: 'hex') => {
      const value = digest(encoding);
      if (typeof value === 'string') {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return value;
    }) as never;
    return hash;
  }) as never);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return (id: string) => counts.get(id.slice('sha256:'.length)) ?? 0;
}

test('why verifies each distinct artifact once, however many references share it', async (t) => {
  const base = await temporary(t);
  const directory = join(base, 'project');
  await initializeProject(directory);
  const evidence = join(base, 'evidence');
  await mkdir(evidence);
  await writeFile(join(evidence, 'big.txt'), 'one\ntwo\nthree\nfour\n');
  await writeFile(join(evidence, 'small.txt'), 'only\n');
  // The page is imported too, so it cites an artifact that is itself.
  const text =
    'a `r1/big.txt#L1` b `r1/big.txt#L2` c `r1/big.txt#L3-L4`' +
    ' d `r1/small.txt#L1` e `r1/page.md#L1` f `r1/missing.md#L1`\n';
  await writeFile(join(evidence, 'page.md'), text);
  const { occurrenceId } = await importPaths(directory, [evidence]);
  const recorded = await recordState(
    directory,
    join(evidence, 'page.md'),
    occurrenceId,
  );
  const revision = await inspectState(directory, recorded.id);
  const artifactOf = (locator: string) => {
    const reference = revision.references.find(
      (item) => item.locator === locator,
    );
    assert.ok(reference?.status === 'resolved', locator);
    return reference.artifact;
  };
  const big = artifactOf('r1/big.txt#L1');
  const small = artifactOf('r1/small.txt#L1');
  assert.equal(artifactOf('r1/page.md#L1'), revision.page);

  const hashed = countDigests(t);
  const explained = await explainLine(directory, recorded.id, 1);
  assert.deepEqual(
    explained.references.map((reference) =>
      'evidence' in reference ? reference.evidence : reference.status,
    ),
    ['one', 'two', 'three\nfour', 'only', text.slice(0, -1), 'unresolved'],
  );
  assert.equal(hashed(big), 1);
  assert.equal(hashed(small), 1);
  assert.equal(hashed(revision.page), 1);
});

test('inspect proves each revision against its occurrence and refuses forged ones', async (t) => {
  const { directory, occurrenceId, elsewhere } = await setup(t);
  const recorded = await recordState(
    directory,
    await page(elsewhere, 'p.md', 'a `r1/evidence/lf.md#L2` b `r2#L1`\n'),
    occurrenceId,
  );
  const inspection = await inspectProject(directory);
  assert.deepEqual(
    inspection.states.map((state) => state.id),
    [recorded.id],
  );
  const revision = await inspectState(directory, recorded.id);
  const states = join(directory, '.sulai', 'states');
  const nth = (value: Record<string, unknown>, index: number) =>
    (value.references as Record<string, unknown>[])[index] as Record<
      string,
      unknown
    >;
  async function forge(
    change: (value: Record<string, unknown>) => void,
    reason: RegExp,
  ) {
    const value = JSON.parse(
      JSON.stringify({ ...revision, id: undefined }),
    ) as Record<string, unknown>;
    delete value.id;
    change(value);
    const { id, bytes } = encodeStateRevision(value);
    const file = join(states, `${id.slice('state:v1:'.length)}.json`);
    await writeFile(file, bytes);
    await assert.rejects(inspectProject(directory), reason);
    await assert.rejects(inspectState(directory, id), reason);
    await rm(file);
  }
  await forge(
    (v) => (nth(v, 0).endByte = 3),
    /references its occurrence does not support/,
  );
  await forge(
    (v) => (nth(v, 1).artifact = hashContent(Buffer.from('other'))),
    /references its occurrence does not support/,
  );
  await forge(
    (v) => (v.references as unknown[]).pop(),
    /does not record exactly what its page cites/,
  );
  await forge(
    (v) => (v.parent = `state:v1:${'b'.repeat(64)}`),
    /parent that is not stored/,
  );
  await writeFile(join(states, 'stray'), 'x');
  await assert.rejects(
    inspectProject(directory),
    /Unexpected entry in the state store/,
  );
  await rm(join(states, 'stray'));
  assert.equal((await inspectProject(directory)).states.length, 1);
});

test('the page is published before the revision, so a failed record leaves no revision', async (t) => {
  const { directory, occurrenceId, elsewhere } = await setup(t);
  const text = 'crash `r2#L1`\n';
  const originalLink = fs.link;
  mockOnce(t, 'link', (async (from: string, to: string) => {
    if (String(to).includes(`${sep}states${sep}`)) {
      throw Object.assign(new Error('Synthetic revision failure'), {
        code: 'ENOSPC',
      });
    }
    return originalLink(from, to);
  }) as never);
  await assert.rejects(
    recordState(directory, await page(elsewhere, 'p.md', text), occurrenceId),
    /Synthetic revision failure/,
  );
  assert.deepEqual(await readdir(join(directory, '.sulai', 'states')), []);
  const stored = (await inspectProject(directory)).artifacts.map(
    (artifact) => artifact.id,
  );
  assert.ok(stored.includes(hashContent(Buffer.from(text))));
});

test('a page must be bounded UTF-8 text, and recording needs a stored occurrence', async (t) => {
  const { directory, occurrenceId, elsewhere } = await setup(t);
  await assert.rejects(
    recordState(
      directory,
      await page(elsewhere, 'bad.md', Buffer.from([0xff, 0x0a])),
      occurrenceId,
    ),
    /UTF-8 text/,
  );
  await assert.rejects(
    recordState(
      directory,
      await page(elsewhere, 'big.md', 'x'.repeat(1024 * 1024 + 1)),
      occurrenceId,
    ),
    /at most/,
  );
  await assert.rejects(
    recordState(
      directory,
      await page(elsewhere, 'ok.md', 'x\n'),
      `occurrence:v1:${'c'.repeat(64)}`,
    ),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    recordState(directory, await page(elsewhere, 'ok.md', 'x\n'), 'not-an-id'),
    /Invalid occurrence ID/,
  );
});

test('the CLI records, shows, explains and diffs state', async (t) => {
  const { directory, occurrenceId, elsewhere } = await setup(t);
  function run(args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    return result;
  }
  const missingFrom = run([
    'state',
    'record',
    directory,
    await page(elsewhere, 'p.md', 'x\n'),
  ]);
  assert.equal(missingFrom.status, 1);
  assert.match(missingFrom.stderr, /Usage:/);
  const a = run([
    'state',
    'record',
    directory,
    await page(elsewhere, 'a.md', 'first `r2#L1`\n'),
    '--from',
    occurrenceId,
  ]);
  assert.equal(a.status, 0, a.stderr);
  const first = JSON.parse(a.stdout) as { id: StateId };
  const b = run([
    'state',
    'record',
    directory,
    await page(elsewhere, 'b.md', 'second `r2#L2`\n'),
    '--from',
    occurrenceId,
  ]);
  const second = JSON.parse(b.stdout) as { id: StateId; parent: string };
  assert.equal(second.parent, first.id);
  const status = JSON.parse(run(['status', directory]).stdout) as {
    heads: { id: string; page: string }[];
  };
  assert.deepEqual(
    status.heads.map((head) => [head.id, head.page]),
    [[second.id, 'second `r2#L2`\n']],
  );
  const why = JSON.parse(run(['why', directory, second.id, '1']).stdout) as {
    references: { evidence: string }[];
  };
  assert.equal(why.references[0]?.evidence, 'two');
  const diff = JSON.parse(
    run(['diff', directory, first.id, second.id]).stdout,
  ) as { changes: unknown[] };
  assert.equal(diff.changes.length, 2);
  const inspected = run(['inspect', directory, second.id]);
  assert.equal(inspected.status, 0, inspected.stderr);
});

/** A project with one evidence directory, acquired again after each change. */
async function evolving(t: TestContext) {
  const base = await temporary(t);
  const directory = join(base, 'project');
  await initializeProject(directory);
  const evidence = join(base, 'evidence');
  await mkdir(evidence);
  const acquire = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(evidence, name), text);
    }
    return (await importPaths(directory, [evidence])).occurrenceId;
  };
  return { base, directory, evidence, acquire };
}

test('a citation kept from the parent must still cite the same text', async (t) => {
  const { base, directory, evidence, acquire } = await evolving(t);
  const text =
    '# State\n- Uses SQLite `r1/plan.md#L2`\n- Owner `r1/team.md#L1`\n';
  const first = await recordState(
    directory,
    await page(base, 'p.md', text),
    await acquire({ 'plan.md': 'plan\nsqlite\n', 'team.md': 'ana\n' }),
  );
  assert.deepEqual(first.changedCitations, []);

  // A line inserted above moves `sqlite` to line 3; line 2 still resolves.
  const moved = await acquire({ 'plan.md': 'plan\nnote\nsqlite\n' });
  const states = join(directory, '.sulai', 'states');
  await assert.rejects(
    recordState(directory, await page(base, 'p.md', text), moved),
    (error: Error) =>
      /1 citation\(s\) kept from the parent/.test(error.message) &&
      /r1\/plan\.md#L2 \(page line 2\): now points at different text/.test(
        error.message,
      ) &&
      /--allow-changed-citations/.test(error.message),
  );
  assert.equal((await readdir(states)).length, 1);

  // Recording anyway is explicit, and the result says what changed.
  const forced = await recordState(
    directory,
    await page(base, 'p.md', text),
    moved,
    undefined,
    { allowChangedCitations: true },
  );
  assert.deepEqual(forced.changedCitations, [
    { locator: 'r1/plan.md#L2', lines: [2], now: 'different-text' },
  ]);

  // A change elsewhere in a file leaves its cited text alone.
  const corrected = text.replace('#L2`', '#L3`');
  const next = await recordState(
    directory,
    await page(base, 'p.md', corrected),
    await acquire({ 'plan.md': 'plan\nnote\nsqlite\nlater\n' }),
  );
  assert.deepEqual(next.changedCitations, []);
  assert.equal(next.parent, forced.id);

  // A kept citation whose file is gone no longer resolves.
  await rm(join(evidence, 'team.md'));
  await assert.rejects(
    recordState(
      directory,
      await page(base, 'p.md', corrected),
      (await importPaths(directory, [evidence])).occurrenceId,
    ),
    /r1\/team\.md#L1 \(page line 3\): no longer resolves/,
  );
});

test('a page can be given as bytes, so a project needs no state file', async (t) => {
  const { directory, acquire } = await evolving(t);
  const occurrenceId = await acquire({ 'plan.md': 'plan\nsqlite\n' });
  const recorded = await recordState(
    directory,
    Buffer.from('# State\n- Uses SQLite `r1/plan.md#L2`\n'),
    occurrenceId,
  );
  assert.equal(recorded.references.resolved, 1);
  const status = await projectStatus(directory);
  assert.equal(
    status.heads[0]?.page,
    '# State\n- Uses SQLite `r1/plan.md#L2`\n',
  );
  await assert.rejects(
    recordState(directory, new Uint8Array(1024 * 1024 + 1), occurrenceId),
    /at most 1048576 bytes/,
  );

  // The CLI reads a page from standard input when it is given as -.
  const result = spawnSync(
    process.execPath,
    [cli, 'state', 'record', directory, '-', '--from', occurrenceId],
    { encoding: 'utf8', input: '# State\n- Plan `r1/plan.md#L1`\n' },
  );
  assert.equal(result.status, 0, result.stderr);
  const piped = JSON.parse(result.stdout) as {
    parent: string;
    changedCitations: unknown[];
  };
  assert.equal(piped.parent, recorded.id);
  assert.deepEqual(piped.changedCitations, []);
});
