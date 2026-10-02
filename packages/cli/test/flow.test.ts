import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  initializeProject,
  orient,
  recordNext,
  recordState,
} from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

// As in git.test.ts: no global or system Git configuration reaches a result.
const isolated = mkdtempSync(join(tmpdir(), 'sulai-flow-config-'));
writeFileSync(join(isolated, 'gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(isolated, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Sulai Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Sulai Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
});
after(() => rmSync(isolated, { recursive: true, force: true }));

const supported = spawnSync('git', ['--no-lazy-fetch', 'version']).status === 0;
const skip = supported ? false : 'needs git 2.45 or later';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function tree(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

const CONFIG = (sort: string) =>
  `// Settings for the list view.\n\nexport const LIST_SORT = '${sort}';\nexport const PAGE_SIZE = 20;\n`;

/** A repository that is also the Sulai project, its store left untracked. */
async function project(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'sulai-flow-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  git(base, 'init', '-q', '--initial-branch=main', 'repo');
  const repo = join(base, 'repo');
  await tree(repo, {
    'src/config.js': CONFIG('date'),
    'README.md': '# linkkeep\n\nSaves links.\n',
  });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  await initializeProject(repo);
  return repo;
}

const FIRST =
  'Lists sort by date. `r1/src/config.js#L3`\nPages hold 20 links. `r1/src/config.js#L4`\n';

/** Someone else changes the sort decision and commits it. */
async function outsideEdit(repo: string) {
  await writeFile(join(repo, 'src', 'config.js'), CONFIG('title'));
  git(
    repo,
    '-c',
    'user.name=Project Owner',
    '-c',
    'user.email=owner@example.invalid',
    'commit',
    '-q',
    '-am',
    'Sort lists by title',
  );
}

const states = async (repo: string) =>
  (await readdir(join(repo, '.sulai', 'states'))).sort();

test(
  'with no state yet, orient observes the working tree and says how to start',
  { skip },
  async (t) => {
    const repo = await project(t);
    const result = await orient(repo);
    assert.deepEqual(result.heads, []);
    assert.equal(result.observed.length, 1);
    const [root] = result.observed[0]?.roots ?? [];
    assert.equal(root?.source, 'git-worktree');
    assert.equal(
      root?.source === 'git-worktree' && root.head,
      git(repo, 'rev-parse', 'HEAD'),
    );
    assert.match(result.next, /No state is recorded yet/);
    assert.match(result.next, /sulai record /);
    assert.deepEqual(await states(repo), []);
  },
);

test(
  'an outside commit that moves cited evidence is reported before the state is used, and nothing is repaired',
  { skip },
  async (t) => {
    const repo = await project(t);
    const first = await recordNext(repo, Buffer.from(FIRST));
    assert.equal(first.parent, null);
    assert.deepEqual(first.references.unresolved, []);
    assert.equal(first.references.resolved, 2);

    const before = await orient(repo);
    assert.equal(before.heads.length, 1);
    assert.deepEqual(before.heads[0]?.changed, []);
    assert.match(before.next, /Every citation still matches/);

    await outsideEdit(repo);
    const recorded = await states(repo);
    const result = await orient(repo);
    const [head] = result.heads;
    assert.equal(head?.revision, first.id);
    assert.equal(head?.page, FIRST);
    assert.equal(head?.changed.length, 1);
    const changed = head?.changed[0];
    assert.equal(changed?.locator, 'r1/src/config.js#L3');
    assert.deepEqual(changed?.lines, [1]);
    assert.equal(changed?.now, 'different-text');
    assert.deepEqual(changed?.cited, {
      text: "export const LIST_SORT = 'date';",
      truncated: false,
    });
    assert.deepEqual(changed?.current, {
      text: "export const LIST_SORT = 'title';",
      truncated: false,
    });
    assert.match(result.next, /1 citation\(s\) no longer match/);
    assert.match(result.next, /yours to judge/);
    // Orienting recorded no revision and changed none.
    assert.deepEqual(await states(repo), recorded);

    // The unchanged page is refused: it still says date over text that says title.
    await assert.rejects(
      recordNext(repo, Buffer.from(FIRST)),
      /no longer cite the same text/,
    );
    assert.deepEqual(await states(repo), recorded);

    // The agent's reading of the change is its own; recording it is explicit.
    const next =
      'Lists sort by title; the owner changed it. `r1/src/config.js#L3`\nPages hold 20 links. `r1/src/config.js#L4`\n';
    const second = await recordNext(repo, Buffer.from(next), {
      allowChangedCitations: true,
    });
    assert.equal(second.parent, first.id);
    assert.equal(second.changedCitations.length, 1);
    const settled = await orient(repo);
    assert.equal(settled.heads[0]?.revision, second.id);
    assert.deepEqual(settled.heads[0]?.changed, []);
  },
);

test(
  'uncommitted work is cited as it is, and an uncommitted change that moves it is reported, with nothing committed',
  { skip },
  async (t) => {
    const repo = await project(t);
    const commits = git(repo, 'rev-list', '--count', 'HEAD');
    // The agent's own work, written and not committed, and a new untracked note.
    await writeFile(
      join(repo, 'src', 'config.js'),
      CONFIG('date').replace('// Settings', '// Decided: date. Settings'),
    );
    await tree(repo, { 'notes/plan.md': 'Try tags next.\n' });
    const page =
      FIRST + 'Why: `r1/src/config.js#L1`\nNext: tags. `r1/notes/plan.md#L1`\n';
    const first = await recordNext(repo, Buffer.from(page));
    assert.deepEqual(first.references.unresolved, []);
    assert.equal(first.references.resolved, 4);
    const why = first.observed.roots[0];
    assert.equal(why?.source, 'git-worktree');

    // Someone else changes the decision in the working tree, and commits nothing.
    await writeFile(
      join(repo, 'src', 'config.js'),
      CONFIG('title').replace('// Settings', '// Decided: date. Settings'),
    );
    const recorded = await states(repo);
    const result = await orient(repo);
    const [head] = result.heads;
    assert.deepEqual(
      head?.changed.map((item) => [
        item.locator,
        item.cited?.text,
        'text' in (item.current ?? {})
          ? (item.current as { text: string }).text
          : undefined,
      ]),
      [
        [
          'r1/src/config.js#L3',
          "export const LIST_SORT = 'date';",
          "export const LIST_SORT = 'title';",
        ],
      ],
    );
    assert.deepEqual(await states(repo), recorded);
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), commits);
    assert.equal(git(repo, 'status', '--porcelain', '--', '.sulai'), '');
  },
);

test(
  'committing everything never commits the store, and an ignore file already there is kept',
  { skip },
  async (t) => {
    const repo = await project(t);
    await recordNext(repo, Buffer.from(FIRST));
    await orient(repo);
    git(repo, 'add', '-A');
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
    assert.equal(git(repo, 'status', '--porcelain'), '');
    // An agent that finds the store is told to read it through Sulai.
    assert.match(
      await readFile(join(repo, '.sulai', 'README.md'), 'utf8'),
      /read the project's state through the `sulai` command[\s\S]*sulai orient \./,
    );

    const base = await mkdtemp(join(tmpdir(), 'sulai-flow-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    await tree(base, { '.sulai/.gitignore': 'artifacts/\n' });
    await initializeProject(base);
    assert.equal(
      await readFile(join(base, '.sulai', '.gitignore'), 'utf8'),
      'artifacts/\n',
    );
  },
);

test(
  'a citation written without backticks is refused, so no page records citing nothing',
  { skip },
  async (t) => {
    const repo = await project(t);
    await assert.rejects(
      recordNext(repo, Buffer.from(FIRST.replaceAll('`', ''))),
      /2 citation\(s\) are not in backticks[\s\S]*r1\/src\/config\.js#L3\n {2}r1\/src\/config\.js#L4/,
    );
    // One left bare beside a proper one is refused too.
    await assert.rejects(
      recordNext(
        repo,
        Buffer.from(
          'Lists sort by date. `r1/src/config.js#L3`, see r1/README.md#L1.\n',
        ),
      ),
      /1 citation\(s\) are not in backticks[\s\S]*r1\/README\.md#L1\n/,
    );
    assert.deepEqual(await states(repo), []);
    // Text that only resembles a locator is not mistaken for one.
    const plain = await recordNext(
      repo,
      Buffer.from(
        'Release br1#L2 and r1#Lx are names. `r1/src/config.js#L3`\n',
      ),
    );
    assert.equal(plain.references.total, 1);
  },
);

test('a folder that is not a repository is observed as a folder', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'sulai-flow-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, 'project');
  await tree(directory, { 'notes.md': 'Decided: sort by date.\n' });
  await initializeProject(directory);

  const empty = await orient(directory);
  assert.equal(empty.observed[0]?.roots[0]?.source, 'filesystem');
  await recordNext(directory, Buffer.from('Sort by date. `r1/notes.md#L1`\n'));

  await writeFile(join(directory, 'notes.md'), 'Decided: sort by title.');
  const result = await orient(directory);
  assert.equal(result.heads[0]?.changed[0]?.locator, 'r1/notes.md#L1');
  assert.deepEqual(result.heads[0]?.changed[0]?.current, {
    text: 'Decided: sort by title.',
    truncated: false,
  });
});

test(
  'with several heads, orient checks each and record asks which one it continues',
  { skip },
  async (t) => {
    const repo = await project(t);
    const first = await recordNext(repo, Buffer.from(FIRST));
    const a = await recordNext(repo, Buffer.from(FIRST + 'A.\n'));
    const b = await recordState(
      repo,
      Buffer.from(FIRST + 'B.\n'),
      a.occurrence,
      first.id,
    );
    await outsideEdit(repo);
    const result = await orient(repo);
    assert.deepEqual(
      result.heads.map((head) => head.revision),
      [a.id, b.id].sort(),
    );
    for (const head of result.heads) {
      assert.deepEqual(
        head.changed.map((item) => item.locator),
        ['r1/src/config.js#L3'],
      );
    }
    // Both heads cite the same roots, so one observation serves both.
    assert.equal(result.observed.length, 1);
    assert.match(result.next, /There are 2 heads/);
    await assert.rejects(
      recordNext(repo, Buffer.from(FIRST)),
      /There are 2 heads/,
    );
  },
);

test(
  'the command line runs the flow from standard input',
  { skip },
  async (t) => {
    const repo = await project(t);
    const run = (args: string[], input?: string) =>
      spawnSync(process.execPath, [cli, ...args], {
        input,
        encoding: 'utf8',
      });

    const recorded = run(['record', repo, '-'], FIRST);
    assert.equal(recorded.status, 0, recorded.stderr);
    const id = (JSON.parse(recorded.stdout) as { id: string }).id;

    await outsideEdit(repo);
    const oriented = run(['orient', repo]);
    assert.equal(oriented.status, 0, oriented.stderr);
    const result = JSON.parse(oriented.stdout) as {
      heads: { revision: string; changed: { locator: string }[] }[];
    };
    assert.equal(result.heads[0]?.revision, id);
    assert.deepEqual(
      result.heads[0]?.changed.map((item) => item.locator),
      ['r1/src/config.js#L3'],
    );

    const refused = run(['record', repo, '-'], FIRST);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--allow-changed-citations/);
    const allowed = run(
      ['record', repo, '-', '--allow-changed-citations'],
      FIRST,
    );
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(run(['record', repo]).status, 1);
  },
);
